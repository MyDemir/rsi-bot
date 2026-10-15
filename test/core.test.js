'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { wilderState, rsiClosed, rsiLive, step } = require('../src/core/rsi');
const { Market } = require('../src/core/market');
const { createSignalEngine, check } = require('../src/core/signals');
const { walk } = require('./helpers/mocks');

const H = 3600e3;
const TFS = [
  { key: '4h', label: '4s', ms: 4 * H, setting: 'tf4h' },
  { key: '12h', label: '12s', ms: 12 * H, setting: 'tf12h' },
  { key: '1d', label: '1g', ms: 24 * H, setting: 'tf1d' },
];
const S = (o = {}) => ({ ustAktif: true, ustEsik: 80, altAktif: true, altEsik: 20, resetPuan: 5, tf4h: true, tf12h: true, tf1d: true, ...o });

// Wilder'in klasik örneği (StockCharts "RSI" açıklaması): 14 dönem
const WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
const WILDER_RSI = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97];

// Bağımsız referans: TradingView Pine tanımı — ta.rma(x, n) ilk değer SMA, sonra alpha = 1/n
function pineRsi(src, n) {
  const up = [], dn = [];
  for (let i = 1; i < src.length; i++) { const d = src[i] - src[i - 1]; up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0)); }
  const rma = x => { let r = null; x.forEach((v, i) => { if (i === n - 1) r = x.slice(0, n).reduce((a, b) => a + b, 0) / n; else if (i >= n) r = (v + (n - 1) * r) / n; }); return r; };
  const u = rma(up), d = rma(dn);
  return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
}

test('RSI: TradingView (Pine ta.rsi) tanımıyla birebir', () => {
  for (const seed of [1, 2, 3]) {
    const c = walk(300, 20, 0.0005, seed, 0.02);
    for (const n of [7, 14, 21]) assert.ok(Math.abs(rsiClosed(wilderState(c, n)) - pineRsi(c, n)) < 1e-9, `seed ${seed} n ${n}`);
  }
});

test('RSI: Wilder klasik örneği (StockCharts tablosu yuvarlanmış ortalamalarla — ±0.1)', () => {
  for (let i = 0; i < WILDER_RSI.length; i++) {
    const r = rsiClosed(wilderState(WILDER.slice(0, 15 + i), 14));
    assert.ok(Math.abs(r - WILDER_RSI[i]) < 0.1, `adım ${i}: ${r.toFixed(2)} ≠ ${WILDER_RSI[i]}`);
  }
});

test('RSI: anlık mum (tek adım) = o mum kapanmış gibi tam hesap', () => {
  const c = walk(200, 100, 0.001, 7);
  const st = wilderState(c.slice(0, -1), 14);
  assert.ok(Math.abs(rsiLive(st, c[c.length - 1]) - rsiClosed(wilderState(c, 14))) < 1e-9);
  assert.equal(rsiLive(null, 5), null);
  assert.equal(wilderState([1, 2, 3], 14), null, 'yetersiz mum → RSI yok');
});

test('RSI: 99 mum ile tüm geçmiş arasındaki fark 0.1 puanın altında (Binance weight 1 yeterli)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const c = walk(800, 50, seed % 2 ? 0.002 : -0.002, seed, 0.03);
    const full = rsiClosed(wilderState(c, 14)), short = rsiClosed(wilderState(c.slice(-99), 14));
    assert.ok(Math.abs(full - short) < 0.1, `seed ${seed}: ${full} vs ${short}`);
  }
});

test('RSI: sadece yükselen seri 100, düz seri 50', () => {
  assert.equal(rsiClosed(wilderState([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14)), 100);
  assert.equal(rsiClosed(wilderState(Array(20).fill(3), 14)), 50);
  assert.ok(step({ ag: 1, al: 1, last: 10, period: 14 }, 13).ag > 1);
});

function rows(closes, price, ms, now) {
  const openNow = Math.floor(now / ms) * ms;
  const all = [...closes, price];
  return all.map((c, i) => { const o = openNow - (all.length - 1 - i) * ms; return [o, c, c, c, String(c), '1', o + ms - 1]; });
}

test('Market: yükleme, anlık fiyat, mum kapanışı ve REST kesinleştirmesi', () => {
  const now = Date.UTC(2026, 9, 15, 10, 30);
  const m = new Market({ tfs: TFS, period: 14 });
  const c = walk(120, 100, 0.002, 3);
  for (const t of TFS) m.load('AUSDT', t.key, rows(c, 130, t.ms, now), now);
  assert.ok(m.ready('AUSDT'));
  const r0 = m.rsi('AUSDT');
  assert.ok(Math.abs(r0['4h'] - rsiLive(wilderState(c, 14), 130)) < 1e-9, 'açık mum dahil');
  assert.ok(Math.abs(m.rsi('AUSDT', false)['4h'] - rsiClosed(wilderState(c, 14))) < 1e-9, 'kapanmış mum');

  // aynı mum içinde fiyat değişimi → mum kapanmaz
  assert.deepEqual(m.onPrice('AUSDT', 131, now + 60e3), []);
  // 12:00 UTC → 4h ve 12h kapanır, 1d kapanmaz
  const t2 = Date.UTC(2026, 9, 15, 12, 0, 5);
  assert.deepEqual(m.onPrice('AUSDT', 132, t2), ['4h', '12h']);
  const s4 = m.coins.get('AUSDT').tf['4h'];
  assert.equal(s4.closes[s4.closes.length - 1], 131, 'kapanan mum son bilinen fiyatla');
  assert.equal(s4.open, Date.UTC(2026, 9, 15, 12));
  assert.equal(m.price('AUSDT'), 132);

  // periyot değişimi
  m.setPeriod(7);
  assert.ok(Math.abs(m.rsi('AUSDT', false)['1d'] - rsiClosed(wilderState(m.coins.get('AUSDT').tf['1d'].closes, 7))) < 1e-9);
  assert.equal(m.klineLimit(), 99);
  m.remove('AUSDT');
  assert.ok(!m.has('AUSDT'));
});

test('Market: uzun kopukluktan sonra açık mum zamana hizalanır', () => {
  const now = Date.UTC(2026, 9, 15, 1);
  const m = new Market({ tfs: TFS.slice(0, 1), period: 14 });
  m.load('B', '4h', rows(walk(50, 10, 0, 1), 10, 4 * H, now), now);
  const later = now + 30 * H;
  m.onPrice('B', 11, later);
  assert.equal(m.coins.get('B').tf['4h'].open, Math.floor(later / (4 * H)) * 4 * H);
});

test('Sinyal: tüm dilimler eşikte → bir kez; geri dönüş (reset) olmadan tekrar yok', () => {
  const e = createSignalEngine({ tfs: TFS });
  const s = S();
  const r = (a, b, c) => ({ '4h': a, '12h': b, '1d': c });
  assert.deepEqual(e.step('X', r(85, 82, 79), s), [], '1g eşik altında');
  assert.deepEqual(e.step('X', r(85, 82, 81), s), ['up']);
  assert.deepEqual(e.step('X', r(86, 83, 82), s), [], 'zaten verildi');
  assert.deepEqual(e.step('X', r(78, 82, 81), s), [], '78: eşik altı ama reset (75) değil');
  assert.deepEqual(e.step('X', r(81, 82, 81), s), [], 'reset olmadığı için yeni sinyal yok');
  assert.deepEqual(e.step('X', r(74, 82, 81), s), [], '74 < 75 → yeniden hazır');
  assert.deepEqual(e.step('X', r(81, 82, 81), s), ['up'], 'yeniden sinyal');
  // aşırı satım
  assert.deepEqual(e.step('Y', r(15, 18, 20), s), ['down'], '≤ 20 dahil');
  assert.deepEqual(e.step('Y', r(15, 18, 24), s), []);
  assert.deepEqual(e.step('Y', r(15, 18, 26), s), [], '26 > 25 → hazır');
  assert.deepEqual(e.step('Y', r(10, 10, 10), s), ['down']);
});

test('Sinyal: kapalı yön, kapalı zaman dilimi, eksik RSI, prime', () => {
  const e = createSignalEngine({ tfs: TFS });
  const r = (a, b, c) => ({ '4h': a, '12h': b, '1d': c });
  assert.deepEqual(e.step('A', r(90, 90, 90), S({ ustAktif: false })), []);
  assert.deepEqual(e.step('B', r(90, 90, 50), S({ tf1d: false })), ['up'], '1g kapalı → 4s+12s yeterli');
  assert.deepEqual(e.step('C', r(90, 90, null), S()), [], 'yeni coin: günlük RSI yok');
  e.prime('D', r(90, 90, 90), S());
  assert.deepEqual(e.step('D', r(91, 91, 91), S()), [], 'açılışta şartta olan sinyal vermez');
  assert.deepEqual(e.step('D', r(60, 91, 91), S()), []);
  assert.deepEqual(e.step('D', r(91, 91, 91), S()), ['up'], 'geri dönüp yeniden girince verir');
  assert.deepEqual(check(r(90, 90, 90), [], S()).up, false, 'seçili dilim yoksa şart yok');
  assert.deepEqual(e.matches(r(90, 90, 90), S()), { up: true, down: false });
  e.forget('D');
  assert.equal(e._state.has('D'), false);
});

test('Sinyal: eşik 85–90 ve 20 civarı ayarlanabilir', () => {
  const e = createSignalEngine({ tfs: TFS });
  const r = { '4h': 87, '12h': 86, '1d': 88 };
  assert.deepEqual(e.step('A', r, S({ ustEsik: 90 })), []);
  assert.deepEqual(e.step('A', r, S({ ustEsik: 85 })), ['up']);
  const lo = { '4h': 22, '12h': 19, '1d': 21 };
  assert.deepEqual(e.step('B', lo, S({ altEsik: 20 })), []);
  assert.deepEqual(e.step('B', lo, S({ altEsik: 25 })), ['down']);
});
