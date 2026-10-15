'use strict';

/**
 * RSI (Wilder) — TradingView ta.rsi ile aynı: ilk ortalama SMA, sonrası RMA.
 * Durum { ag, al, last, period } kapanmış mumlardan kurulur; açık mumun anlık fiyatı tek adımla eklenir.
 */

function wilderState(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return { ag, al, last: closes[closes.length - 1], period };
}

function step(st, price) {
  const p = st.period, d = price - st.last;
  return { ag: (st.ag * (p - 1) + (d > 0 ? d : 0)) / p, al: (st.al * (p - 1) + (d < 0 ? -d : 0)) / p, last: price, period: p };
}

function rsiOf(ag, al) {
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}

/** Kapanmış mumların RSI'ı */
function rsiClosed(st) { return st ? rsiOf(st.ag, st.al) : null; }

/** Açık mum dahil (fiyat = açık mumun şu anki kapanışı) */
function rsiLive(st, price) {
  if (!st || !Number.isFinite(price)) return rsiClosed(st);
  const s = step(st, price);
  return rsiOf(s.ag, s.al);
}

/** Basit (yavaş) referans: tüm diziden RSI — testler için */
function rsiSeries(closes, period) {
  const st = wilderState(closes, period);
  return rsiClosed(st);
}

module.exports = { wilderState, step, rsiOf, rsiClosed, rsiLive, rsiSeries };
