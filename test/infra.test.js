'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettings } = require('../src/settings/store');
const { cryptoPerpetuals, isTradfi, createBinance, klineWeight } = require('../src/exchange/binance');
const { createTelegram, splitText } = require('../src/telegram/client');
const fmt = require('../src/app/format');
const { normSym } = require('../src/telegram/commands');
const { startBinance, startTelegram, waitFor } = require('./helpers/mocks');

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-bot-'));

test('Ayarlar: doğrulama, kalıcılık, en az bir zaman dilimi, sıfırlama', () => {
  const file = path.join(tmp(), 'settings.json');
  const s = createSettings({ file, logger: quiet });
  s.load();
  const seen = [];
  s.onChange((k, v) => seen.push(`${k}=${v}`));
  assert.deepEqual(s.set('ustEsik', '85'), { ok: true, value: 85 });
  assert.equal(s.set('ustEsik', '100').ok, false, 'aralık dışı');
  assert.equal(s.set('altEsik', '20,5').value, 21, 'virgül + tam adım');
  assert.equal(s.set('ustAktif', 'kapat').value, false);
  assert.equal(s.set('yok', 1).ok, false);
  assert.equal(s.set('tf4h', 'kapat').ok, true);
  assert.equal(s.set('tf12h', 'kapat').ok, true);
  assert.match(s.set('tf1d', 'kapat').error, /En az bir zaman dilimi/);
  assert.equal(s.bump('listeDk', 1).value, 75);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).values, { ustEsik: 85, altEsik: 21, ustAktif: false, tf4h: false, tf12h: false, listeDk: 75 }, 'yalnız değişenler yazılır');

  const s2 = createSettings({ file, logger: quiet });
  s2.load();
  assert.equal(s2.get().ustEsik, 85, 'yeniden başlatmada korunur');
  s2.reset();
  assert.equal(s2.get().ustEsik, 80);
  assert.ok(seen.includes('ustEsik=85'));
});

test('Binance: yalnız kripto perpetual — hisse/ETF (SOXS gibi), stablecoin, vadeli/kapalı alınmaz', () => {
  const info = { symbols: [
    { symbol: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: 'BTC', underlyingType: 'COIN' },
    { symbol: 'SOXSUSDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: 'SOXS' },
    { symbol: 'TSLAUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: 'TSLA', underlyingType: 'EQUITY' },
    { symbol: 'XAUUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: 'XAU', underlyingSubType: ['TradFi'] },
    { symbol: 'USDCUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: 'USDC' },
    { symbol: 'ETHUSDT_261225', contractType: 'CURRENT_QUARTER', status: 'TRADING', quoteAsset: 'USDT', baseAsset: 'ETH' },
    { symbol: 'OLDUSDT', contractType: 'PERPETUAL', status: 'SETTLING', quoteAsset: 'USDT', baseAsset: 'OLD' },
    { symbol: 'BTCUSDC', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDC', baseAsset: 'BTC' },
    { symbol: '1000PEPEUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: '1000PEPE', underlyingType: 'COIN' },
  ] };
  assert.deepEqual(cryptoPerpetuals(info, ['USDC']), ['BTCUSDT', '1000PEPEUSDT']);
  assert.ok(isTradfi(info.symbols[1]) && isTradfi(info.symbols[2]) && isTradfi(info.symbols[3]) && !isTradfi(info.symbols[0]));
  assert.deepEqual([99, 100, 499, 500, 1000, 1500].map(klineWeight), [1, 2, 2, 5, 5, 10]);
});

test('Binance: 429 + Retry-After → bekleyip tekrar dener', async () => {
  const market = { __fail429: 1, BTCUSDT: { closes: {}, price: 100 } };
  const b = startBinance(18451, market);
  try {
    const bn = createBinance({ base: 'http://127.0.0.1:18451', logger: quiet });
    const t0 = Date.now();
    const p = await bn.prices();
    assert.equal(p.get('BTCUSDT'), 100);
    assert.ok(Date.now() - t0 >= 900, 'Retry-After kadar beklendi');
    await assert.rejects(bn.klines('NOPEUSDT', '4h', 99), /HTTP 400/);
  } finally { b.srv.close(); }
});

test('Telegram: uzun mesaj bölünür, 429 sonrası tekrar, yetki listesi', async () => {
  const parts = splitText(Array.from({ length: 500 }, (_, i) => `satır ${i} ${'x'.repeat(20)}`).join('\n'));
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 4000));
  const tg = startTelegram(18452);
  try {
    tg.fail429 = 1;
    const c = createTelegram({ apiBase: 'http://127.0.0.1:18452', token: 'T', chatId: '-1001', adminIds: ['42'], minIntervalMs: 0, logger: quiet });
    c.send('merhaba');
    await waitFor(() => tg.sent.length === 1, 5000, '429 sonrası gönderim');
    assert.equal(tg.sent[0].text, 'merhaba');
    assert.equal(await c.isAdmin(42), true);
    assert.equal(await c.isAdmin(7), false);
  } finally { tg.srv.close(); }
});

test('Biçim: sinyal ve liste mesajları', () => {
  const TFS = [{ key: '4h', label: '4s' }, { key: '12h', label: '12s' }, { key: '1d', label: '1g' }];
  const s = { ustEsik: 80, altEsik: 20, ustAktif: true, altAktif: false, rsiPeriod: 14, anlik: true };
  const o = { s, tfs: TFS, keys: ['4h', '12h', '1d'], now: Date.UTC(2026, 9, 15, 11, 5), tz: 'Europe/Istanbul' };
  const one = fmt.signalText('up', [{ sym: 'BTCUSDT', rsis: { '4h': 84.23, '12h': 82.1, '1d': 80.5 }, price: 67123.46, chg: 5.2 }], o);
  assert.match(one, /🔴 <b>#BTCUSDT<\/b> — RSI aşırı alım/);
  assert.match(one, /4s <b>84\.2<\/b> · 12s <b>82\.1<\/b> · 1g <b>80\.5<\/b>/);
  assert.match(one, /Fiyat: 67123\.5 · 24s: \+%5\.2/);
  assert.match(one, /⏱ 15\.10 14:05/, 'İstanbul saati');
  const many = fmt.signalText('down', [{ sym: 'A', rsis: { '4h': 10, '12h': 12, '1d': 15 }, price: 0.0123456 }, { sym: 'B', rsis: {}, price: 2 }], o);
  assert.match(many, /2 coin/);
  assert.match(many, /#A .*0\.01235/);
  const list = fmt.listText({ up: [], down: [] }, o);
  assert.match(list, /Aşırı alım<\/b> \(4s\/12s\/1g RSI ≥ 80\): yok/);
  assert.match(list, /Aşırı satım: <i>kapalı<\/i>/);
  assert.equal(normSym('btc'), 'BTCUSDT');
  assert.equal(normSym(' 1000pepeusdt '), '1000PEPEUSDT');
});
