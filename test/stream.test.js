'use strict';

/**
 * scalp-bot'tan taşınan mum altyapısı: WS gecikme ölçümü (Binance E → yerel), pencere sayaçları,
 * yeniden bağlanmada zamanlayıcı temizliği, paralel mum kesinleştirme, nabız uyarıları.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const baseCfg = require('../src/config');
const { createApp } = require('../src/app/bot');
const { createSettings } = require('../src/settings/store');
const { createStream } = require('../src/exchange/stream');
const { createLoadMonitor } = require('../src/app/load');
const { startWs, waitFor, sleep } = require('./helpers/mocks');

const quiet = { log() {}, warn() {}, error() {} };
const H = 3600e3, TFMS = { '4h': 4 * H, '12h': 12 * H, '1d': 24 * H };

function rows(interval, n) {
  const ms = TFMS[interval], open = Math.floor(Date.now() / ms) * ms;
  return Array.from({ length: n }, (_, i) => {
    const t = open - (n - 1 - i) * ms, c = 100 + Math.sin(i) * 3;
    return [t, String(c), String(c + 1), String(c - 1), String(c), '1', t + ms - 1];
  });
}

test('Stream: gecikme Binance olay zamanından (E) ölçülür, pencere sayaçları sıfırlanır, kopuşta zamanlayıcı birikmez', async () => {
  const ws = startWs(18491);
  const s = createStream({ onData() {}, options: { url: 'ws://127.0.0.1:18491/market/stream', minBackoffMs: 50 }, logger: quiet });
  try {
    s.start();
    await waitFor(() => ws.conns.length === 1 && s.isOpen(), 2000, 'bağlantı');
    ws.push('!miniTicker@arr', [{ e: '24hrMiniTicker', E: Date.now() - 3000, s: 'BTCUSDT', c: '1' }]);
    ws.push('!markPrice@arr@1s', [{ e: 'markPriceUpdate', E: Date.now() - 1000, s: 'BTCUSDT', r: '0' }]);
    ws.push('!miniTicker@arr', [{ e: '24hrMiniTicker', E: Date.now() + 60_000, s: 'BTCUSDT', c: '1' }]);   // saat ileri: eksiye düşmez
    await waitFor(() => s.stats.messages === 3, 2000, 'mesajlar');
    let w = s.takeWindow();
    assert.equal(w.messages, 3);
    assert.ok(w.lagMaxMs >= 2900 && w.lagMaxMs < 4000, `en fazla ≈3 sn (${w.lagMaxMs})`);
    assert.ok(w.lagAvgMs >= 1300 && w.lagAvgMs < 2000, `ort ≈1,3 sn (${w.lagAvgMs})`);

    for (let i = 0; i < 3; i++) {
      ws.dropAll();
      await waitFor(() => ws.conns.length === 1 && s.isOpen(), 3000, `yeniden bağlantı ${i + 1}`);
    }
    w = s.takeWindow();
    assert.equal(w.messages, 0, 'pencere sıfırlandı');
    assert.equal(w.reconnects, 3);
    assert.equal(w.lagAvgMs, null);
    assert.equal(s.stats.reconnects, 3, 'kümülatif sayaç korunur');
  } finally { s.stop(); ws.close(); }
});

test('Kesinleştirme: aynı anda kapanan mumlar sınırlı paralellikle REST\'ten çekilir; hata alan tekrar sıraya girer', async () => {
  const SYMS = Array.from({ length: 30 }, (_, i) => `C${i}USDT`);
  let active = 0, peak = 0, failOnce = new Set(), calls = 0;
  const binance = {
    stats: { usedWeight: 0 },
    exchangeInfo: async () => ({ symbols: SYMS.map(s => ({ symbol: s, contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: s.slice(0, -4) })) }),
    klines: async (s, i, l) => {
      calls++; active++; peak = Math.max(peak, active);
      await sleep(20);
      active--;
      if (failOnce.delete(s)) throw new Error('HTTP 503');
      return rows(i, l);
    },
    prices: async () => new Map(SYMS.map(s => [s, 100])),
    premium: async () => new Map(),
    tickers24h: async () => new Map(SYMS.map(s => [s, { vol: 5e8, chg: 1 }])),
  };
  const telegram = { send() {}, queueLength: () => 0, stats: {} };
  const streamFactory = () => ({ start() {}, stop() {}, silenceMs: () => 0, isOpen: () => true });
  const cfg = { ...baseCfg, resyncConcurrency: 6, loadConcurrency: 3 };
  const app = createApp({ cfg, binance, telegram, settings: createSettings({ persist: false }), logger: quiet, streamFactory });
  try {
    await app.start();
    assert.ok(peak <= 3, `yükleme paralelliği ${peak}`);
    peak = 0; calls = 0; failOnce.add('C3USDT');
    for (const s of SYMS) app._resync.set(`${s}|4h`, 0);
    const t0 = Date.now();
    await app.resyncTick();
    assert.equal(peak, 6, 'kesinleştirme paralelliği');
    assert.equal(calls, 30);
    assert.ok(Date.now() - t0 < 30 * 20, 'sıralıdan hızlı');
    assert.deepEqual([...app._resync.keys()], ['C3USDT|4h'], 'hatalı mum tekrar sırada');
  } finally { app.stop(); }
});

test('Nabız: sayaçlar pencere farkı; WS gecikmesi ve yeniden bağlanma sebebiyle uyarılır; panelde görünür', async () => {
  const logs = [], warns = [];
  const logger = { log: m => logs.push(m), warn: m => warns.push(m), error() {} };
  const win = { messages: 120, reconnects: 2, lagAvgMs: 4000, lagMaxMs: 25_000, windowMs: 300_000 };
  const streamFactory = () => ({ start() {}, stop() {}, silenceMs: () => 0, isOpen: () => true, takeWindow: () => win });
  const binance = {
    stats: { usedWeight: 7 },
    exchangeInfo: async () => ({ symbols: [{ symbol: 'AAAUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: 'AAA' }] }),
    klines: async (s, i, l) => rows(i, l),
    prices: async () => new Map([['AAAUSDT', 100]]),
    premium: async () => new Map(),
    tickers24h: async () => new Map([['AAAUSDT', { vol: 5e8, chg: 1 }]]),
  };
  const telegram = { send() {}, queueLength: () => 0, stats: {} };
  const app = createApp({ cfg: baseCfg, binance, telegram, settings: createSettings({ persist: false }), logger, streamFactory });
  try {
    await app.start();
    app.stats.wsUpdates = 500;
    app.heartbeat();
    app.stats.wsUpdates = 800;
    const beat = app.heartbeat();
    const lines = logs.filter(l => l.startsWith('[NABIZ]'));
    assert.match(lines[0], /500 fiyat güncellemesi/);
    assert.match(lines[1], /300 fiyat güncellemesi/, 'kümülatif değil, pencere farkı');
    assert.match(lines[1], /gecikme ort 4\.0 \/ en fazla 25\.0 sn · 2 yeniden bağlanma/);
    assert.match(lines[1], /CPU %\d+.*event loop p99/);
    assert.ok(beat.load && Number.isFinite(beat.load.cpuPct));
    assert.ok(warns.some(w => /WS gecikmesi 25 sn'ye çıktı — /.test(w)));
    assert.ok(warns.some(w => /2 WebSocket yeniden bağlanması/.test(w)));
    const h = app.healthReport();
    assert.equal(h.metrics['WS gecikme'], 'ort 4.0 sn · en fazla 25.0 sn');
    assert.match(h.metrics['Süreç yükü'], /event loop/);
    assert.ok(Object.keys(h.metrics).length <= 20);
  } finally { app.stop(); }
});

test('Süreç yükü: event loop tıkanması ölçülür', async () => {
  const m = createLoadMonitor();
  try {
    await sleep(50);
    const t = Date.now(); while (Date.now() - t < 300) { /* tıka */ }
    await sleep(50);
    const l = m.take();
    assert.ok(l.loopMaxMs >= 200, `en fazla ${l.loopMaxMs} ms`);
    assert.ok(l.cpuPct > 0);
  } finally { m.stop(); }
});
