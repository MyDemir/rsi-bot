'use strict';

/**
 * Uçtan uca: sahte Binance + sahte Telegram ile gerçek uygulama akışı.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const baseCfg = require('../src/config');
const { createBinance } = require('../src/exchange/binance');
const { createTelegram } = require('../src/telegram/client');
const { installCommands } = require('../src/telegram/commands');
const { createSettings } = require('../src/settings/store');
const { createApp } = require('../src/app/bot');
const { startBinance, startTelegram, walk, waitFor, sleep } = require('./helpers/mocks');

const PB = 18461, PT = 18462, CHAT = -1001, ADMIN = 42, USER = 7;
const quiet = { log() {}, warn() {}, error() {} };

const series = (drift, seed, p0 = 100) => {
  const c = walk(101, p0, drift, seed, 0.03);
  return { closes: { '4h': c.slice(0, 100), '12h': c.slice(0, 100), '1d': c.slice(0, 100) }, price: c[100] };
};

test('Uçtan uca: açılış, sinyal döngüsü, birleşik mesaj, komutlar, menü, liste', { timeout: 60_000 }, async () => {
  const market = {
    BTCUSDT: series(0, 1, 60000),
    HOTUSDT: series(0.015, 2),           // yükselen → RSI ~96
    HOT2USDT: series(0.015, 3),          // RSI ~88
    COLDUSDT: series(-0.015, 4),         // düşen → RSI ~15
    SOXSUSDT: { ...series(0.015, 5), contractType: 'TRADIFI_PERPETUAL' },   // hisse/ETF — izlenmemeli
    USDCUSDT: { ...series(0, 6, 1), base: 'USDC' },
  };
  const base = Object.fromEntries(Object.entries(market).map(([k, v]) => [k, v.price]));
  const { srv: bsrv, hits } = startBinance(PB, market);
  const tg = startTelegram(PT, { admins: [ADMIN] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-e2e-'));
  let offset = 0;
  const now = () => Date.now() + offset;

  const cfg = { ...baseCfg, priceEveryMs: 150, batchMs: 120, resyncDelayMs: 100, settingsDebounceMs: 150, tickersEveryMs: 60_000, universeEveryMs: 3_600_000, heartbeatMs: 3_600_000 };
  const settings = createSettings({ file: path.join(dir, 'settings.json'), logger: quiet });
  settings.load();
  const binance = createBinance({ base: `http://127.0.0.1:${PB}`, weightPerMin: 60_000, logger: quiet });
  const telegram = createTelegram({ apiBase: `http://127.0.0.1:${PT}`, token: 'T', chatId: String(CHAT), minIntervalMs: 0, logger: quiet });
  const app = createApp({ cfg, binance, telegram, settings, logger: quiet, now });
  installCommands({ telegram, settings, app });
  const texts = () => tg.sent.map(m => m.text);
  const signals = () => tg.sent.filter(m => /— RSI aşırı|RSI aşırı (alım|satım)<\/b> ·/.test(m.text));

  try {
    await telegram.start();
    await app.start();

    // ── Açılış ──
    await waitFor(() => texts().some(t => t.includes('RSI botu hazır')), 5000, 'hazır mesajı');
    const ready = texts().find(t => t.includes('RSI botu hazır'));
    assert.match(ready, /4 kripto vadeli kontrat izleniyor/);
    assert.match(ready, /#HOTUSDT/); assert.match(ready, /#HOT2USDT/); assert.match(ready, /#COLDUSDT/);
    assert.doesNotMatch(ready, /SOXS|USDCUSDT/);
    assert.ok(!hits.some(h => /klines (SOXSUSDT|USDCUSDT)/.test(h)), 'hisse ve stablecoin için mum bile istenmez');
    assert.equal(hits.filter(h => h.includes('klines')).length, 12, '4 coin × 3 zaman dilimi');
    await sleep(500);
    assert.equal(signals().length, 0, 'açılışta şartta olanlar için sinyal yağmuru yok');

    // ── Aşırı alım: geri çekilme (reset) → yeniden şart → tek birleşik mesaj ──
    market.HOTUSDT.price = base.HOTUSDT * 0.6; market.HOT2USDT.price = base.HOT2USDT * 0.6;
    await waitFor(() => !app.engine._state.get('HOTUSDT').up && !app.engine._state.get('HOT2USDT').up, 3000, 'reset');
    assert.equal(signals().length, 0);
    market.HOTUSDT.price = base.HOTUSDT; market.HOT2USDT.price = base.HOT2USDT;
    await waitFor(() => signals().length === 1, 3000, 'aşırı alım sinyali');
    const up = signals()[0];
    assert.match(up.text, /🔴 <b>RSI aşırı alım<\/b> · 4s\/12s\/1g RSI ≥ 80 — 2 coin/);
    assert.match(up.text, /#HOTUSDT/); assert.match(up.text, /#HOT2USDT/);
    assert.equal(up.disable_notification, undefined, 'varsayılan sesli');
    await sleep(400);
    assert.equal(signals().length, 1, 'şartta kalan coin tekrar sinyal vermez');

    // ── Aşırı satım: tek coin → ayrıntılı mesaj ──
    market.COLDUSDT.price = base.COLDUSDT * 1.15;    // ılımlı tepki: RSI 25'in üstüne (80'e değil)
    await waitFor(() => !app.engine._state.get('COLDUSDT').down, 3000, 'reset (satım)');
    await sleep(300);
    assert.equal(signals().length, 1, 'tepki aşırı alım sinyali üretmemeli');
    market.COLDUSDT.price = base.COLDUSDT;
    await waitFor(() => signals().length === 2, 3000, 'aşırı satım sinyali');
    assert.match(signals()[1].text, /🟢 <b>#COLDUSDT<\/b> — RSI aşırı satım\n4s <b>[\d.]+<\/b> · 12s <b>[\d.]+<\/b> · 1g <b>[\d.]+<\/b>\nFiyat: .+ · 24s: \+%1\.5\n⏱ /);

    // ── Komutlar ──
    tg.command(CHAT, USER, '/liste');
    await waitFor(() => texts().some(t => t.startsWith('📋 <b>RSI listesi')), 3000, '/liste');
    tg.command(CHAT, USER, '/rsi hot');
    await waitFor(() => texts().some(t => t.startsWith('📈 <b>#HOTUSDT')), 3000, '/rsi');
    assert.match(texts().find(t => t.startsWith('📈 <b>#HOTUSDT')), /Aşırı alım şartında/);
    tg.command(CHAT, USER, '/rsi soxs');
    await waitFor(() => texts().some(t => t.includes('SOXSUSDT izlenmiyor')), 3000, '/rsi hisse');
    tg.command(CHAT, USER, '/ayar ustEsik 99');
    await waitFor(() => texts().some(t => t.includes('yalnız grup yöneticileri')), 3000, 'yetkisiz');
    assert.equal(settings.get().ustEsik, 80);
    tg.command(CHAT, ADMIN, '/ayar ustEsik 99');
    await waitFor(() => texts().some(t => t.includes('Ayar değişti')), 3000, 'ayar değişti listesi');
    assert.match(texts().find(t => t.includes('Ayar değişti')), /RSI ≥ 99\): yok/);
    tg.command(CHAT, ADMIN, '/ayar ustEsik 80');
    await waitFor(() => texts().filter(t => t.includes('Ayar değişti')).length === 2, 3000, 'eşik geri');
    assert.match(texts().filter(t => t.includes('Ayar değişti'))[1], /#HOTUSDT/);
    await sleep(400);
    assert.equal(signals().length, 2, 'eşik değişince şarttakiler için sinyal yağmuru yok');
    tg.command(CHAT, USER, '/durum');
    await waitFor(() => texts().some(t => t.includes('4 izleniyor · 4 hazır')), 3000, '/durum');

    // ── Menü (butonlar) ──
    tg.command(CHAT, USER, '/ayarlar');
    await waitFor(() => tg.sent.some(m => m.text.includes('RSI botu ayarları') && m.reply_markup), 3000, '/ayarlar');
    tg.click(CHAT, USER, 'g:esik');
    await waitFor(() => tg.edits.some(e => e.text.includes('🎯 Eşikler')), 3000, 'bölüm');
    tg.click(CHAT, USER, 't:ustAktif');
    await waitFor(() => tg.answers.some(a => a.show_alert && /yöneticiler/.test(a.text)), 3000, 'buton yetkisiz');
    tg.click(CHAT, ADMIN, 'e:altEsik');
    await waitFor(() => tg.edits.some(e => e.text.includes('Alt eşik') && e.reply_markup.inline_keyboard[0].some(b => b.text === '✓ 20')), 3000, 'hazır değerler');
    tg.click(CHAT, ADMIN, 'v:altEsik:30');
    await waitFor(() => tg.answers.some(a => a.text === '✅ Alt eşik: 30'), 3000, 'hazır değer seç');
    tg.click(CHAT, ADMIN, 's:altEsik:-5');
    await waitFor(() => settings.get().altEsik === 25, 3000, '−5');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).values, { altEsik: 25 }, 'kalıcı');

    // ── Periyodik liste (saat başı) ──
    settings.set('listeDk', 60);
    app.listTick();
    const before = texts().filter(t => t.startsWith('📋 <b>RSI listesi')).length;
    offset += 3_600_000;
    app.listTick();
    await waitFor(() => texts().filter(t => t.startsWith('📋 <b>RSI listesi')).length === before + 1, 3000, 'periyodik liste');

    // ── Mum kapanışı → REST ile kesinleştirme ──
    const k0 = hits.filter(h => h.includes('klines HOTUSDT 4h')).length;
    offset += 4 * 3_600_000;
    await waitFor(() => hits.filter(h => h.includes('klines HOTUSDT 4h')).length > k0, 5000, 'kesinleştirme');
  } finally {
    app.stop(); telegram.stop();
    bsrv.close(); tg.srv.close();
  }
});
