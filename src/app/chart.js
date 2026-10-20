'use strict';

/**
 * Kart grafiği (PNG): mumlar + altta RSI paneli (üst / alt eşik çizgileri) + son fiyat etiketi.
 * Yazı tipi repo içinde (src/assets/fonts, DejaVu) — sunucu imajında sistem fontu yok.
 * @napi-rs/canvas yoksa ya da çizim hata verirse null döner → kart grafiksiz (yalnız metin) gider.
 * (Font yükleme ve renkler scalp-bot chart.js'ten.)
 */

const path = require('path');
const { wilderState, step, rsiOf } = require('../core/rsi');

let canvasLib = null;
function lib() {
  if (canvasLib === false) return null;
  if (!canvasLib) {
    try {
      canvasLib = require('@napi-rs/canvas');
      const dir = path.join(__dirname, '..', 'assets', 'fonts');
      canvasLib.GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSans.ttf'), 'ChartSans');
      canvasLib.GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSans-Bold.ttf'), 'ChartSansBold');
    } catch (err) {
      console.warn(`[GRAFİK] @napi-rs/canvas yüklenemedi (${err.message}) — kartlar grafiksiz gider`);
      canvasLib = false;
      return null;
    }
  }
  return canvasLib;
}

const C = {
  bg: '#0f141b', grid: '#1c2430', axis: '#8b96a5', text: '#d7dde6', faint: '#5d6878',
  up: '#26a69a', down: '#ef5350', rsi: '#b388ff', hot: 'rgba(239,83,80,0.12)', cold: 'rgba(38,166,154,0.12)', last: '#f5a623',
};

const TF_NAME = { '1d': 'Günlük', '4h': '4 saat', '1w': 'Haftalık' };

function fmtPx(v) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  return v.toFixed(a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7);
}

/** Mum kapanışlarından RSI dizisi (ilk period mum null) */
function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let st = wilderState(closes.slice(0, period + 1), period);
  if (!st) return out;
  out[period] = rsiOf(st.ag, st.al);
  for (let i = period + 1; i < closes.length; i++) { st = step(st, closes[i]); out[i] = rsiOf(st.ag, st.al); }
  return out;
}

function dateLabel(t, tf, tz) {
  const o = tf === '4h' ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { day: '2-digit', month: '2-digit' };
  try { return new Intl.DateTimeFormat('tr-TR', { timeZone: tz, ...o }).format(new Date(t)).replace(',', ''); } catch { return new Date(t).toISOString().slice(5, 10); }
}

/**
 * @param {object} p
 * @param {string} p.symbol  @param {string} p.tf '1d'|'4h'|'1w'
 * @param {{t,o,h,l,c}[]} p.candles  eski → yeni (son mum açık olabilir)
 * @param {number} p.period  @param {number} p.ust  @param {number} p.alt
 * @param {string} [p.title]  ör. 'RSI aşırı alım'
 * @returns {Buffer|null} PNG
 */
function renderChart({ symbol, tf, candles, period = 14, ust = 80, alt = 20, title = '', show = 90, tz = 'Europe/Istanbul' }) {
  const L = lib();
  if (!L || !Array.isArray(candles) || candles.length < period + 5) return null;
  try {
    const rsiAll = rsiSeries(candles.map(c => c.c), period);
    const n = Math.min(show, candles.length);
    const cs = candles.slice(-n), rs = rsiAll.slice(-n);
    const W = 1000, H = 640, padL = 12, padR = 92, top = 54, priceH = 380, gap = 14, rsiH = 150;
    const rsiTop = top + priceH + gap, bottom = rsiTop + rsiH;
    const cv = L.createCanvas(W, H), g = cv.getContext('2d');
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);

    // Başlık
    g.fillStyle = C.text; g.font = '22px ChartSansBold'; g.textBaseline = 'middle';
    g.fillText(`#${symbol}`, padL + 4, 26);
    const w0 = g.measureText(`#${symbol}`).width;
    g.font = '17px ChartSans'; g.fillStyle = C.axis;
    g.fillText(`  ·  ${TF_NAME[tf] || tf}${title ? `  ·  ${title}` : ''}`, padL + 4 + w0, 27);

    const plotW = W - padL - padR, bw = plotW / n;
    const x = i => padL + i * bw + bw / 2;

    // Fiyat ekseni
    let hi = -Infinity, lo = Infinity;
    for (const c of cs) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    hi += pad; lo -= pad;
    const y = v => top + (hi - v) / (hi - lo) * priceH;
    g.strokeStyle = C.grid; g.lineWidth = 1; g.font = '13px ChartSans'; g.fillStyle = C.axis;
    for (let k = 0; k <= 5; k++) {
      const v = lo + (hi - lo) * k / 5, yy = Math.round(y(v)) + 0.5;
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(W - padR, yy); g.stroke();
      g.fillText(fmtPx(v), W - padR + 8, yy);
    }

    // Mumlar
    const body = Math.max(1, bw * 0.62);
    cs.forEach((c, i) => {
      const col = c.c >= c.o ? C.up : C.down;
      g.strokeStyle = col; g.fillStyle = col;
      g.beginPath(); g.moveTo(Math.round(x(i)) + 0.5, y(c.h)); g.lineTo(Math.round(x(i)) + 0.5, y(c.l)); g.stroke();
      const y1 = y(Math.max(c.o, c.c)), y2 = y(Math.min(c.o, c.c));
      g.fillRect(x(i) - body / 2, y1, body, Math.max(1, y2 - y1));
    });

    // Son fiyat
    const last = cs[cs.length - 1].c, yl = y(last);
    g.setLineDash([4, 4]); g.strokeStyle = C.last;
    g.beginPath(); g.moveTo(padL, yl); g.lineTo(W - padR, yl); g.stroke(); g.setLineDash([]);
    g.fillStyle = C.last; g.fillRect(W - padR + 2, yl - 11, padR - 4, 22);
    g.fillStyle = '#111'; g.font = '13px ChartSansBold'; g.fillText(fmtPx(last), W - padR + 7, yl);

    // RSI paneli
    const ry = v => rsiTop + (100 - v) / 100 * rsiH;
    g.fillStyle = C.hot; g.fillRect(padL, ry(100), plotW, ry(ust) - ry(100));
    g.fillStyle = C.cold; g.fillRect(padL, ry(alt), plotW, ry(0) - ry(alt));
    g.strokeStyle = C.grid; g.strokeRect(padL + 0.5, rsiTop + 0.5, plotW, rsiH);
    g.font = '12px ChartSans';
    for (const [v, col] of [[ust, C.down], [alt, C.up], [50, C.faint]]) {
      g.setLineDash(v === 50 ? [2, 4] : [5, 4]); g.strokeStyle = col;
      g.beginPath(); g.moveTo(padL, ry(v)); g.lineTo(W - padR, ry(v)); g.stroke();
      g.setLineDash([]); g.fillStyle = col; g.fillText(String(v), W - padR + 8, ry(v));
    }
    g.strokeStyle = C.rsi; g.lineWidth = 2; g.beginPath();
    let started = false;
    rs.forEach((v, i) => { if (v == null) return; if (!started) { g.moveTo(x(i), ry(v)); started = true; } else g.lineTo(x(i), ry(v)); });
    g.stroke(); g.lineWidth = 1;
    const lastR = rs[rs.length - 1];
    if (Number.isFinite(lastR)) {
      g.fillStyle = C.rsi; g.fillRect(W - padR + 2, ry(lastR) - 11, padR - 4, 22);
      g.fillStyle = '#111'; g.font = '13px ChartSansBold'; g.fillText(`RSI ${lastR.toFixed(1)}`, W - padR + 6, ry(lastR));
    }
    g.fillStyle = C.axis; g.font = '13px ChartSans';
    g.fillText(`RSI(${period})`, padL + 6, rsiTop + 12);

    // Zaman ekseni
    g.fillStyle = C.faint; g.font = '12px ChartSans'; g.textAlign = 'center';
    for (let k = 0; k < 6; k++) {
      const i = Math.round((n - 1) * k / 5);
      g.fillText(dateLabel(cs[i].t, tf, tz), Math.min(W - padR - 30, Math.max(padL + 30, x(i))), bottom + 16);
    }
    g.textAlign = 'left';
    return cv.toBuffer('image/png');
  } catch (err) {
    console.warn(`[GRAFİK] ${symbol} çizilemedi: ${err.message}`);
    return null;
  }
}

/** Binance kline satırları → mumlar */
const toCandles = rows => rows.map(r => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));

module.exports = { renderChart, toCandles, rsiSeries, TF_NAME, available: () => Boolean(lib()) };
