'use strict';

/**
 * Coin başına, zaman dilimi başına: kapanmış mum kapanışları + Wilder durumu + açık mumun anlık fiyatı.
 * Fiyat her geldiğinde açık mum güncellenir; mum süresi dolunca son fiyatla kapatılır (sonra REST ile kesinleşir).
 */

const { wilderState, step, rsiClosed, rsiLive } = require('./rsi');

const KEEP = 500;   // tutulan en fazla kapanmış mum

class Market {
  /** @param {{tfs:{key,ms}[], period:number}} o */
  constructor({ tfs, period = 14 }) {
    this.tfs = tfs;
    this.period = period;
    this.coins = new Map();   // sym → { price, tf: { [key]: { closes, st, open, close } } }
  }

  has(sym) { return this.coins.has(sym); }
  symbols() { return [...this.coins.keys()]; }
  remove(sym) { this.coins.delete(sym); }

  coin(sym) {
    let c = this.coins.get(sym);
    if (!c) { c = { price: null, tf: {} }; this.coins.set(sym, c); }
    return c;
  }

  /** Tüm zaman dilimleri yüklendi mi */
  ready(sym) {
    const c = this.coins.get(sym);
    return Boolean(c) && this.tfs.every(t => c.tf[t.key]);
  }

  /**
   * REST kline satırlarından yükle. Satır: [openTime, o, h, l, c, v, closeTime, ...]
   * closeTime < now olanlar kapanmış, sonuncusu (açık) anlık mumdur.
   */
  load(sym, tfKey, rows, now = Date.now()) {
    const tf = this.tfs.find(t => t.key === tfKey);
    const closes = [];
    let open = null, close = null;
    for (const r of rows) {
      const o = Number(r[0]), ct = Number(r[6]), c = parseFloat(r[4]);
      if (!Number.isFinite(c)) continue;
      if (ct < now) closes.push(c);
      else { open = o; close = c; }
    }
    if (open == null) {            // açık mum yok (ör. işlem durmuş) — son kapanıştan sonraki dönemi aç
      const last = rows.length ? Number(rows[rows.length - 1][0]) : Math.floor(now / tf.ms) * tf.ms - tf.ms;
      open = last + tf.ms; close = closes.length ? closes[closes.length - 1] : null;
    }
    if (closes.length > KEEP) closes.splice(0, closes.length - KEEP);
    const c = this.coin(sym);
    c.tf[tfKey] = { closes, st: wilderState(closes, this.period), open, close };
    if (close != null && c.price == null) c.price = close;
  }

  /**
   * Anlık fiyat. Süresi dolan mumlar son bilinen fiyatla kapatılır.
   * @returns {string[]} kapanan zaman dilimleri (REST ile kesinleştirilmeli)
   */
  onPrice(sym, price, now = Date.now()) {
    const c = this.coins.get(sym);
    if (!c || !Number.isFinite(price) || price <= 0) return [];
    const rolled = [];
    for (const t of this.tfs) {
      const s = c.tf[t.key];
      if (!s) continue;
      let n = 0;
      while (now >= s.open + t.ms && n < 3) {     // (uzun kopukluk: en fazla 3 mum sar, gerisini REST düzeltir)
        const fin = s.close ?? price;
        s.closes.push(fin);
        if (s.closes.length > KEEP) s.closes.shift();
        s.st = s.st ? step(s.st, fin) : wilderState(s.closes, this.period);
        s.open += t.ms; s.close = price; n++;
      }
      if (now >= s.open + t.ms) s.open = Math.floor(now / t.ms) * t.ms;
      if (n) rolled.push(t.key);
      s.close = price;
    }
    c.price = price;
    return rolled;
  }

  /** @returns {{[tfKey]: number|null}} */
  rsi(sym, live = true) {
    const c = this.coins.get(sym);
    const out = {};
    for (const t of this.tfs) {
      const s = c?.tf[t.key];
      out[t.key] = !s ? null : live ? rsiLive(s.st, s.close) : rsiClosed(s.st);
    }
    return out;
  }

  price(sym) { return this.coins.get(sym)?.price ?? null; }

  /** RSI periyodu değişti: durumları kapanışlardan yeniden kur */
  setPeriod(period) {
    this.period = period;
    for (const c of this.coins.values()) for (const s of Object.values(c.tf)) s.st = wilderState(s.closes, period);
  }

  /**
   * REST'ten istenecek mum sayısı. RSI(14) için 99 mum (Binance weight 1) yeterli: Wilder ortalamasının
   * başlangıç etkisi 85 adımda (13/14)^85 ≈ %0.2'ye iner → TradingView ile fark 0.1 puanın altında.
   */
  klineLimit() { return Math.min(499, Math.max(99, this.period * 7)); }
}

module.exports = { Market };
