'use strict';

/**
 * Dayanıklılık: geçici Binance hataları coini kör bırakmaz, hacim verisi yokken evren boşalmaz,
 * grafik isteği Telegram kuyruğunu bekletmez, saat ekleri doğru.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const baseCfg = require('../src/config');
const { createApp } = require('../src/app/bot');
const { createSettings } = require('../src/settings/store');
const { createBinance } = require('../src/exchange/binance');
const fmt = require('../src/app/format');
const { startBinance } = require('./helpers/mocks');

const quiet = { log() {}, warn() {}, error() {} };
const H = 3600e3, TFMS = { '4h': 4 * H, '12h': 12 * H, '1d': 24 * H, '1w': 168 * H };
const SYMS = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];

function rows(interval, n) {
  const ms = TFMS[interval], open = Math.floor(Date.now() / ms) * ms;
  return Array.from({ length: n }, (_, i) => {
    const t = open - (n - 1 - i) * ms, c = 100 + Math.sin(i) * 3;
    return [t, String(c), String(c + 1), String(c - 1), String(c), '1', t + ms - 1];
  });
}

/** Ağsız sahte Binance; fail.klines / fail.tickers ile hata verdirilir */
function fakeBinance(fail = {}) {
  return {
    stats: { usedWeight: 0 },
    exchangeInfo: async () => ({ symbols: SYMS.map(s => ({ symbol: s, contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: s.slice(0, 3) })) }),
    klines: async (s, i, l) => { if (fail.klines?.has(s)) throw new Error('HTTP 503'); if (fail.chart && l === 150) return fail.chart(); return rows(i, l); },
    prices: async () => new Map(SYMS.map(s => [s, 100])),
    premium: async () => new Map(),
    tickers24h: async () => { if (fail.tickers) throw new Error('HTTP 503'); return new Map(SYMS.map(s => [s, { vol: 5e8, chg: 1 }])); },
  };
}
const telegram = { send() {}, queueLength: () => 0, stats: {} };
const streamFactory = () => ({ start() {}, stop() {}, silenceMs: () => 0, isOpen: () => true });
const makeApp = (binance, settings = createSettings({ persist: false }), cfg = baseCfg) => createApp({ cfg, binance, telegram, settings, logger: quiet, streamFactory });

test('Açılışta yüklenemeyen coin yeniden denenir ve izlenmeye başlar', async () => {
  const fail = { klines: new Set(['BBBUSDT']) };
  const app = makeApp(fakeBinance(fail));
  try {
    await app.start();
    assert.deepEqual(app.market.symbols().sort(), ['AAAUSDT', 'CCCUSDT']);
    assert.ok(app.failed.has('BBBUSDT'));
    await app.retryFailed();
    assert.ok(app.failed.has('BBBUSDT'), 'hata sürerken listede kalır');
    fail.klines.clear();
    await app.retryFailed();
    assert.ok(app.market.ready('BBBUSDT'), 'Binance düzelince yüklendi');
    assert.equal(app.failed.size, 0);
  } finally { app.stop(); }
});

test('Hacim süzgeci açıkken 24s verisi alınamazsa evren boşalmaz; veri gelince süzgeç uygulanır', async () => {
  const settings = createSettings({ persist: false });
  settings.set('minHacimM', 10);
  const fail = { tickers: true };
  const b = fakeBinance(fail);
  const app = makeApp(b, settings);
  try {
    await app.start();
    assert.equal(app.market.symbols().length, SYMS.length);
    fail.tickers = false;
    b.tickers24h = async () => new Map(SYMS.map(s => [s, { vol: s === 'CCCUSDT' ? 1e6 : 5e8, chg: 1 }]));
    await app.refreshTickers();
    assert.deepEqual(app.market.symbols().sort(), ['AAAUSDT', 'BBBUSDT'], 'düşük hacimli coin çıkarıldı');
  } finally { app.stop(); }
});

test('Grafik: mumlar süre içinde gelmezse hata (kart grafiksiz gider), önbellek varsa o kullanılır', async () => {
  let mode = 'ok';
  const chart = () => (mode === 'hang' ? new Promise(() => {}) : Promise.resolve(rows('4h', 150)));
  const cfg = { ...baseCfg, chartTimeoutMs: 200, chartCacheMs: 0 };
  const app = makeApp(fakeBinance({ chart }), undefined, cfg);
  try {
    await app.start();
    mode = 'hang';
    const t0 = Date.now();
    await assert.rejects(app.chartPng('AAAUSDT', '1w'), /yanıt yok/);
    assert.ok(Date.now() - t0 < 1000, 'kuyruk beklemedi');
    mode = 'ok';
    await app.chartPng('AAAUSDT', '4h');
    mode = 'hang';
    await app.chartPng('AAAUSDT', '4h');                // süre doldu ama önbellek var → hata yok
  } finally { app.stop(); }
});

test('Binance: tekrar denenmeyen istek 429 alınca beklemeden düşer ama diğer istekler hız sınırına uyar', async () => {
  const market = { __fail429: 1, BTCUSDT: { closes: {}, price: 100 } };
  const b = startBinance(18471, market);
  try {
    const bn = createBinance({ base: 'http://127.0.0.1:18471', logger: quiet });
    const t0 = Date.now();
    await assert.rejects(bn.klines('BTCUSDT', '4h', 150, { retries: 0 }), /HTTP 429/);
    assert.ok(Date.now() - t0 < 500, 'grafik isteği beklemedi');
    assert.ok(bn.backlogMs() >= 500, 'Retry-After süresi kuyruğa işlendi');
  } finally { b.srv.close(); }
});

test('Saat eki okunuşa göre: 19:00\'da, 03:00\'te, 11:00\'de, 12:40\'ta', () => {
  const cases = { '00:00': 'da', '03:00': 'te', '07:00': 'de', '11:00': 'de', '15:00': 'te', '16:00': 'da', '19:00': 'da', '20:00': 'de', '23:00': 'te', '12:40': 'ta', '19:30': 'da', '19:45': 'te', '08:50': 'de', '09:10': 'da' };
  for (const [hm, suf] of Object.entries(cases)) assert.equal(fmt.locSuffix(hm), suf, hm);
});
