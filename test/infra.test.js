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

test('Biçim: kart (RSI alt alta, fiyat, funding) ve liste', () => {
  const TFS = [{ key: '4h', label: '4s', long: '4 saat' }, { key: '12h', label: '12s', long: '12 saat' }, { key: '1d', label: '24s', long: '24 saat' }];
  const s = { ustEsik: 80, altEsik: 20, ustAktif: true, altAktif: false, rsiPeriod: 14, anlik: true };
  const now = Date.UTC(2026, 9, 15, 11, 5);
  const o = { s, tfs: TFS, keys: ['4h', '12h', '1d'], now, tz: 'Europe/Istanbul' };
  const card = fmt.cardText('up', { sym: 'BTCUSDT', rsis: { '4h': 84.23, '12h': 82.1, '1d': 80.5 }, price: 67123.46, chg: 5.2, funding: { rate: 0.0001, next: Date.UTC(2026, 9, 15, 16) } }, o);
  assert.match(card, /^🔴 <b>#BTCUSDT<\/b> · RSI aşırı alım\n<pre>RSI 4 saat    84\.2\nRSI 12 saat   82\.1\nRSI 24 saat   80\.5<\/pre>\n/);
  assert.match(card, /💲 Fiyat: <b>67123\.5<\/b> · 24 sa \+%5\.2/);
  assert.match(card, /💸 Funding: \+%0\.0100 · 19:00'de \(4 sa 55 dk sonra\)/, 'funding oranı + İstanbul saatiyle sonraki zaman');
  assert.match(card, /⏱ 15\.10 14:05 · şart: 4s · 12s · 24s RSI ≥ 80/);
  assert.equal(fmt.fundingText({ rate: -0.000375, next: null }, now, 'UTC'), '−%0.0375');
  assert.equal(fmt.fundingText(undefined, now, 'UTC'), '—');
  const two = fmt.cardText('down', { sym: 'A', rsis: { '4h': 10, '1d': 15 }, price: 0.0123456 }, { ...o, keys: ['4h', '1d'] });
  assert.match(two, /<pre>RSI 4 saat    10\.0\nRSI 24 saat   15\.0<\/pre>/, 'yalnız seçili dilimler');
  assert.match(two, /0\.01235/);
  const list = fmt.listText({ up: [], down: [] }, o);
  assert.match(list, /Aşırı alım<\/b> \(4s · 12s · 24s RSI ≥ 80\): yok/);
  assert.match(list, /Aşırı satım: <i>kapalı<\/i>/);
  assert.equal(normSym('btc'), 'BTCUSDT');
  assert.equal(normSym(' 1000pepeusdt '), '1000PEPEUSDT');
});

test('Ayarlar: grafik zaman dilimi (Günlük / 4 saat / Haftalık)', () => {
  const s = createSettings({ persist: false, logger: quiet });
  assert.equal(s.get().grafik, true);
  assert.equal(s.get().grafikTf, '4h');
  assert.equal(s.set('grafikTf', 'haftalık').value, '1w', 'etiketle de olur');
  assert.equal(s.set('grafikTf', '1d').value, '1d');
  assert.match(s.set('grafikTf', '1h').error, /1d \(Günlük\), 4h \(4 saat\), 1w \(Haftalık\)/);
  assert.equal(s.set('grafik', 'kapat').value, false);
});

test('Ayarlar: bozuk / eski dosya değerleri yok sayılır', () => {
  const file = path.join(tmp(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ values: { ustEsik: 500, grafikTf: '1h', sesli: 'evet', altEsik: 15, eskiAyar: 3 } }));
  const s = createSettings({ file, logger: quiet });
  s.load();
  assert.equal(s.get().ustEsik, 80); assert.equal(s.get().grafikTf, '4h'); assert.equal(s.get().sesli, true); assert.equal(s.get().altEsik, 15);
});

test('Telegram: fotoğraflı kart gönderim anında çizilir; çizilemezse metin gider; bayat kart atlanır; yanıt öne geçer', async () => {
  const tg = startTelegram(18453);
  try {
    const c = createTelegram({ apiBase: 'http://127.0.0.1:18453', token: 'T', chatId: '-1001', minIntervalMs: 0, cardTtlMs: 50, logger: quiet });
    const { renderChart } = require('../src/app/chart');
    const candles = Array.from({ length: 60 }, (_, i) => ({ t: i * 4 * 3600e3, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i }));
    let drawn = 0;
    c.send('<b>kart 1</b>', { kind: 'card', photo: async () => { drawn++; return renderChart({ symbol: 'XUSDT', tf: '4h', candles }); } });
    c.send('kart 2', { kind: 'card', photo: async () => null });
    await waitFor(() => tg.sent.length === 2, 5000, 'iki kart');
    assert.equal(drawn, 1);
    assert.equal(tg.sent[0].method, 'sendPhoto'); assert.ok(tg.sent[0].photoPng, 'PNG'); assert.equal(tg.sent[0].caption, '<b>kart 1</b>');
    assert.equal(tg.sent[1].method, 'sendMessage', 'grafik yoksa metin');
    // bayat kart: kuyruk meşgulken bekleyen kart TTL'yi aşar
    const slow = createTelegram({ apiBase: 'http://127.0.0.1:18453', token: 'T', chatId: '-1001', minIntervalMs: 120, cardTtlMs: 100, logger: quiet });
    slow.send('ilk', { kind: 'info' }); slow.send('bayat kart', { kind: 'card' });
    await slow._internal.handleUpdate({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: -1001 }, from: { id: 1 }, text: '/x' } });
    await slow.flush(3000);
    assert.ok(!tg.sent.some(m => m.text === 'bayat kart'), 'bayat kart gönderilmedi');
    assert.ok(tg.sent.some(m => m.text === 'ilk'));
  } finally { tg.srv.close(); }
});
