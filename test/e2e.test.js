'use strict';

/**
 * Uçtan uca: sahte Binance REST + sahte Binance WebSocket + sahte Telegram ile gerçek uygulama akışı.
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
const { startBinance, startTelegram, startWs, miniTickers, walk, waitFor, sleep } = require('./helpers/mocks');

const PB = 18461, PT = 18462, PW = 18463, CHAT = -1001, ADMIN = 42, USER = 7;
const quiet = { log() {}, warn() {}, error() {} };

const series = (drift, seed, p0 = 100) => {
  const c = walk(101, p0, drift, seed, 0.03);
  return { closes: { '4h': c.slice(0, 100), '12h': c.slice(0, 100), '1d': c.slice(0, 100) }, price: c[100] };
};

test('Uçtan uca: WebSocket, ayrı kartlar, funding, grafik, kopma/yedek, ayar paneli', { timeout: 90_000 }, async () => {
  const market = {
    BTCUSDT: series(0, 1, 60000),
    HOTUSDT: series(0.015, 2),           // RSI ~96
    HOT2USDT: series(0.015, 3),          // RSI ~88
    COLDUSDT: series(-0.015, 4),         // RSI ~15
    SOXSUSDT: { ...series(0.015, 5), contractType: 'TRADIFI_PERPETUAL' },   // hisse/ETF — izlenmez
    USDCUSDT: { ...series(0, 6, 1), base: 'USDC' },
  };
  const base = Object.fromEntries(Object.entries(market).map(([k, v]) => [k, v.price]));
  const { srv: bsrv, hits } = startBinance(PB, market);
  const tg = startTelegram(PT, { admins: [ADMIN] });
  const ws = startWs(PW);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-e2e-'));
  let offset = 0;
  const now = () => Date.now() + offset;

  const cfg = {
    ...baseCfg, wsUrl: `ws://127.0.0.1:${PW}/market/stream`, wsStaleMs: 60_000, fallbackAfterMs: 600, priceEveryMs: 200,
    resyncDelayMs: 100, settingsDebounceMs: 150, tickersEveryMs: 600_000, reconcileEveryMs: 600_000, universeEveryMs: 3_600_000, heartbeatMs: 3_600_000,
  };
  const settings = createSettings({ file: path.join(dir, 'settings.json'), logger: quiet });
  settings.load();
  const binance = createBinance({ base: `http://127.0.0.1:${PB}`, weightPerMin: 60_000, logger: quiet });
  const telegram = createTelegram({ apiBase: `http://127.0.0.1:${PT}`, token: 'T', chatId: String(CHAT), minIntervalMs: 0, logger: quiet });
  const app = createApp({ cfg, binance, telegram, settings, logger: quiet, now });
  installCommands({ telegram, settings, app });
  const texts = () => tg.sent.map(m => m.text || '');
  const cards = () => tg.sent.filter(m => /^(⏳.*\n)?(🔴|🟢) <b>#\w+<\/b> · RSI aşırı/.test(m.text || ''));
  const tick = syms => ws.push('!miniTicker@arr', miniTickers(market, syms));
  const ALL = ['BTCUSDT', 'HOTUSDT', 'HOT2USDT', 'COLDUSDT', 'SOXSUSDT', 'USDCUSDT'];

  try {
    await telegram.start();
    await app.start();

    // ── Açılış ──
    await waitFor(() => texts().some(t => t.includes('RSI botu hazır')), 5000, 'hazır mesajı');
    const ready = texts().find(t => t.includes('RSI botu hazır'));
    assert.match(ready, /4 kripto vadeli kontrat izleniyor/);
    assert.match(ready, /#HOTUSDT/); assert.match(ready, /#COLDUSDT/);
    assert.doesNotMatch(ready, /SOXS|USDCUSDT/);
    assert.ok(!hits.some(h => /klines (SOXSUSDT|USDCUSDT)/.test(h)), 'hisse ve stablecoin için mum istenmez');
    await waitFor(() => ws.conns.length === 1, 3000, 'WebSocket bağlantısı');
    assert.match(ws.conns[0].url, /^\/market\/stream\?streams=!miniTicker@arr\/!markPrice@arr@1s$/, 'tek bağlantı, iki tüm-piyasa akışı');

    // ── Funding akıştan ──
    ws.push('!markPrice@arr@1s', [{ e: 'markPriceUpdate', s: 'HOTUSDT', p: String(market.HOTUSDT.price), r: '0.00025000', T: Date.now() + 2 * 3600e3 + 60e3 }]);
    await waitFor(() => app.funding.get('HOTUSDT')?.rate === 0.00025, 2000, 'funding');
    tick(ALL);
    await sleep(300);
    assert.equal(cards().length, 0, 'açılışta şartta olanlar için kart yağmuru yok');

    // ── Aşırı alım: iki coin aynı anda → İKİ AYRI kart (grafikli) ──
    market.HOTUSDT.price = base.HOTUSDT * 0.6; market.HOT2USDT.price = base.HOT2USDT * 0.6;
    tick(['HOTUSDT', 'HOT2USDT']);
    await waitFor(() => !app.engine._state.get('HOTUSDT').up && !app.engine._state.get('HOT2USDT').up, 3000, 'reset');
    market.HOTUSDT.price = base.HOTUSDT; market.HOT2USDT.price = base.HOT2USDT;
    tick(['HOTUSDT', 'HOT2USDT']);
    await waitFor(() => cards().length === 2, 8000, 'iki ayrı kart');
    const [c1, c2] = cards();
    assert.ok([c1, c2].every(c => c.method === 'sendPhoto' && c.photoPng), 'grafikli kart (PNG)');
    assert.deepEqual([c1, c2].map(c => c.caption.match(/#(\w+)/)[1]).sort(), ['HOT2USDT', 'HOTUSDT']);
    const hot = [c1, c2].find(c => c.caption.includes('#HOTUSDT')).caption;
    assert.match(hot, /<pre>RSI 4 saat +[\d.]+\nRSI 12 saat +[\d.]+\nRSI 24 saat +[\d.]+<\/pre>/, 'RSI alt alta');
    assert.match(hot, /💸 Funding: \+%0\.0250 · \d\d:\d\d'de \(2 sa 1 dk sonra\)/);
    assert.match(hot, /💲 Fiyat: <b>[\d.]+<\/b> · 24 sa \+%2\.0/);
    assert.ok(hits.some(h => h === '/fapi/v1/klines HOTUSDT 4h'), 'grafik için 4 saatlik mum (varsayılan)');
    tick(['HOTUSDT', 'HOT2USDT']);
    await sleep(400);
    assert.equal(cards().length, 2, 'şartta kalan coin tekrar kart vermez');

    // ── Grafik kapalı → metin kart ──
    settings.set('grafik', false);
    market.COLDUSDT.price = base.COLDUSDT * 1.15;
    tick(['COLDUSDT']);
    await waitFor(() => !app.engine._state.get('COLDUSDT').down, 3000, 'reset (satım)');
    market.COLDUSDT.price = base.COLDUSDT;
    tick(['COLDUSDT']);
    await waitFor(() => cards().length === 3, 5000, 'aşırı satım kartı');
    assert.equal(cards()[2].method, 'sendMessage');
    assert.match(cards()[2].text, /^🟢 <b>#COLDUSDT<\/b> · RSI aşırı satım\n<pre>/);
    settings.set('grafik', true);

    // ── Kopma: WebSocket düşer, bu arada 4 saatlik mum kapanır → dönüşte REST ile tamamlanır, kesinleşene kadar kilit ──
    const priceHits = hits.filter(h => h === '/fapi/v2/ticker/price').length;
    ws.dropAll();
    offset += 4 * 3600e3;
    await waitFor(() => ws.conns.length === 1, 5000, 'yeniden bağlantı');
    tick(['BTCUSDT']);                                  // ilk mesaj → onGap
    await waitFor(() => app.stats.gaps === 1, 3000, 'kopukluk tamamlandı');
    assert.ok(hits.filter(h => h === '/fapi/v2/ticker/price').length > priceHits, 'REST fiyat');
    await waitFor(() => app.blocked.size === 0, 8000, 'kilit kalktı');
    assert.ok(hits.filter(h => h === '/fapi/v1/klines HOTUSDT 4h').length >= 3, 'mumlar REST ile kesinleşti');
    assert.equal(cards().length, 3, 'kopukluk kart üretmedi');

    // ── WebSocket sessiz → REST yedeği; mesaj gelince kapanır ──
    const p2 = hits.filter(h => h === '/fapi/v2/ticker/price').length;
    await waitFor(() => hits.filter(h => h === '/fapi/v2/ticker/price').length >= p2 + 2, 4000, 'REST yedeği');
    assert.match(app.statusText(), /REST yedeği/);
    tick(['BTCUSDT']);
    await waitFor(() => /✅ WebSocket/.test(app.statusText()), 2000, 'WebSocket geri');

    // ── Ayar paneli ──
    tg.command(CHAT, USER, '/ayarlar');
    await waitFor(() => tg.sent.some(m => (m.text || '').includes('RSI Botu · Ayarlar') && m.reply_markup), 3000, '/ayarlar');
    const pnl = tg.sent.find(m => (m.text || '').includes('RSI Botu · Ayarlar'));
    const btns = pnl.reply_markup.inline_keyboard.flat().map(b => b.text);
    for (const b of ['🔴 Aşırı alım: Açık', 'Eşik ≥ 80  ✏️', '✅ 24 saat', '🖼 Grafik: Açık', '○ Günlük', '◉ 4 saat', '○ Haftalık', '⚙️ Gelişmiş', '✖️ Kapat']) assert.ok(btns.includes(b), `buton: ${b} — ${btns.join(' | ')}`);
    tg.click(CHAT, USER, 'v:grafikTf:1w:m');
    await waitFor(() => tg.answers.some(a => a.show_alert && /yöneticiler/.test(a.text)), 3000, 'yetkisiz');
    assert.equal(settings.get().grafikTf, '4h');
    tg.click(CHAT, ADMIN, 'v:grafikTf:1w:m');
    await waitFor(() => tg.answers.some(a => a.text === '✅ Grafik zaman dilimi: Haftalık'), 3000, 'haftalık');
    assert.ok(tg.edits.at(-1).reply_markup.inline_keyboard.flat().some(b => b.text === '◉ Haftalık'), 'panel yerinde güncellendi');
    tg.click(CHAT, ADMIN, 'e:ustEsik');
    await waitFor(() => tg.edits.some(e => e.text.includes('Aşırı alım eşiği') && e.reply_markup.inline_keyboard[0].some(b => b.text === '✓ 80')), 3000, 'eşik sayfası');
    tg.click(CHAT, ADMIN, 'v:ustEsik:85:e');
    await waitFor(() => settings.get().ustEsik === 85, 3000, 'eşik 85');
    tg.click(CHAT, ADMIN, 's:ustEsik:5');
    await waitFor(() => settings.get().ustEsik === 90, 3000, '+5');
    tg.click(CHAT, ADMIN, 'v:ustEsik:80:e');
    tg.click(CHAT, ADMIN, 'p:a');
    await waitFor(() => tg.edits.some(e => e.text.includes('Ayarlar › Gelişmiş')), 3000, 'gelişmiş');
    tg.click(CHAT, ADMIN, 't:tf4h:m'); tg.click(CHAT, ADMIN, 't:tf12h:m');
    await waitFor(() => !settings.get().tf4h && !settings.get().tf12h, 3000, 'dilim kapat');
    tg.click(CHAT, ADMIN, 't:tf1d:m');
    await waitFor(() => tg.answers.some(a => /En az bir zaman dilimi/.test(a.text)), 3000, 'son dilim kapanmaz');
    tg.click(CHAT, ADMIN, 't:tf4h:m'); tg.click(CHAT, ADMIN, 't:tf12h:m');
    tg.click(CHAT, USER, 'x');
    await waitFor(() => tg.deletes.length === 1, 3000, 'kapat');
    await waitFor(() => settings.get().tf4h && settings.get().tf12h && settings.get().ustEsik === 80, 3000, 'geri al');
    await sleep(400);
    assert.equal(cards().length, 3, 'ayar değişiklikleri kart yağmuru üretmedi');

    // ── /rsi: grafikli yanıt (haftalık) ──
    tg.command(CHAT, USER, '/rsi hot');
    await waitFor(() => tg.sent.some(m => m.method === 'sendPhoto' && /^📈 <b>#HOTUSDT/.test(m.caption || '')), 5000, '/rsi');
    assert.ok(hits.includes('/fapi/v1/klines HOTUSDT 1w'), 'haftalık grafik mumu');
    tg.command(CHAT, USER, '/rsi soxs');
    await waitFor(() => texts().some(t => t.includes('SOXSUSDT izlenmiyor')), 3000, '/rsi hisse');
    tg.command(CHAT, USER, '/durum');
    await waitFor(() => texts().some(t => t.includes('4 izleniyor · 4 hazır') && t.includes('WebSocket')), 3000, '/durum');

    // ── Periyodik liste ──
    app.listTick();
    await telegram.flush(3000);
    const before = texts().filter(t => t.startsWith('📋 <b>RSI listesi')).length;
    offset += 3_600_000;
    app.listTick();
    await waitFor(() => texts().filter(t => t.startsWith('📋 <b>RSI listesi')).length === before + 1, 3000, 'periyodik liste');
  } finally {
    app.stop(); telegram.stop();
    bsrv.close(); tg.srv.close(); ws.close();
  }
});
