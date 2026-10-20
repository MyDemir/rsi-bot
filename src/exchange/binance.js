'use strict';

/**
 * Binance USDⓈ-M Futures REST istemcisi (Node'un yerleşik fetch'i, harici kütüphane yok).
 * Hız sınırlayıcı ve tekrar deneme mantığı scalp-bot altyapısından (binanceClient.js) alınmıştır:
 *   • Tüm istekler sıraya girer, her biri weight'i kadar süre tüketir (IP başına 2400 weight/dk sınırı)
 *   • 429 / -1003 / Retry-After → bekleyip tekrar; ağ ve 5xx hataları → 2/4/8 sn ile tekrar
 *   • 418 (IP yasağı) Retry-After taşıyorsa yasak süresi kadar beklenir; başlıksız 418 ve diğer 4xx'ler tekrar DENENMEZ
 * Kullanılan uç noktaların hepsi herkese açık; BINANCE_API_KEY tanımlıysa başlıkta gönderilir.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Kripto dışı (TradFi) kontrat mı — hisse, ETF, altın/gümüş, döviz (ör. SOXSUSDT, TSLAUSDT, XAUUSDT) */
const TRADFI_TYPES = new Set(['EQUITY', 'STOCK', 'ETF', 'COMMODITY', 'METAL', 'FX', 'FOREX']);
function isTradfi(s) {
  if (s.contractType === 'TRADIFI_PERPETUAL') return true;
  if (TRADFI_TYPES.has(String(s.underlyingType || '').toUpperCase())) return true;
  return Array.isArray(s.underlyingSubType) && s.underlyingSubType.some(x => /tradfi/i.test(String(x)));
}

/**
 * İzlenecek kontratlar: işlemdeki USDT-margined KRİPTO perpetual'lar.
 * Hisse/ETF/emtia/döviz kontratları ve stablecoin bazlılar alınmaz.
 */
function cryptoPerpetuals(info, excludeBases = []) {
  const ex = new Set(excludeBases.map(x => x.toUpperCase()));
  return (info?.symbols || [])
    .filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .filter(s => !isTradfi(s) && !ex.has(String(s.baseAsset).toUpperCase()))
    .map(s => s.symbol);
}

// Binance futures klines weight: limit <100 → 1, <500 → 2, ≤1000 → 5, >1000 → 10
const klineWeight = limit => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10);

function isTransient(err) {
  const code = err?.cause?.code || err?.code;
  if (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|UND_ERR)/.test(code)) return true;
  if (err?.name === 'TimeoutError' || /fetch failed|socket hang up|network|timeout/i.test(String(err?.message))) return true;
  return err?.status >= 500 && err?.status < 600;
}

function createBinance({ base, apiKey = '', weightPerMin = 1800, logger = console } = {}) {
  let nextSlotAt = 0;
  const stats = { requests: 0, errors: 0, usedWeight: 0 };

  async function limited(weight, fn) {
    const now = Date.now();
    const start = Math.max(now, nextSlotAt);
    nextSlotAt = start + weight * (60_000 / weightPerMin);
    if (start > now) await sleep(start - now);
    return fn();
  }

  async function withRetry(fn, label, maxRetries = 3) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const rateLimited = err?.status === 429 || err?.code === -1003 || Number.isFinite(err?.retryAfter);
        if (!rateLimited && isTransient(err) && attempt < maxRetries) {
          const waitMs = 2000 * 2 ** attempt;
          logger.warn(`[BINANCE] ${label}: geçici hata (${err.message}) — ${waitMs / 1000} sn sonra tekrar (${attempt + 1}/${maxRetries})`);
          await sleep(waitMs);
          continue;
        }
        stats.errors++;
        if (!rateLimited) throw err;
        const waitSec = err.retryAfter > 0 ? err.retryAfter : 60;
        nextSlotAt = Math.max(nextSlotAt, Date.now() + waitSec * 1000);   // diğer istekler de beklesin (tekrar denenmese de)
        if (attempt >= maxRetries) throw err;
        logger.warn(`[BINANCE] ${label}: hız sınırı — ${waitSec} sn bekleniyor (${attempt + 1}/${maxRetries})`);
        await sleep(waitSec * 1000);
      }
    }
  }

  async function get(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
    const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, {
      headers: apiKey ? { 'X-MBX-APIKEY': apiKey } : {},
      signal: AbortSignal.timeout(15_000),
    });
    stats.requests++;
    const used = Number(res.headers.get('x-mbx-used-weight-1m'));
    if (Number.isFinite(used)) stats.usedWeight = used;
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(`${path}: HTTP ${res.status}${body.msg ? ` (${body.msg})` : ''}`);
      err.status = res.status; err.code = body.code;
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
      throw err;
    }
    return res.json();
  }

  const call = (weight, label, path, params, retries = 3) => withRetry(() => limited(weight, () => get(path, params)), label, retries);

  return {
    stats,
    backlogMs: () => Math.max(0, nextSlotAt - Date.now()),
    exchangeInfo: () => call(1, 'exchangeInfo', '/fapi/v1/exchangeInfo'),
    /**
     * @param {{retries?:number}} [o]  retries 0: hata / hız sınırında beklemeden fırlat (grafik gibi beklemeye değmeyen istekler)
     * @returns ham satırlar [[openTime, o, h, l, c, v, closeTime, ...]]
     */
    klines: (symbol, interval, limit, { retries = 3 } = {}) => call(klineWeight(limit), `klines ${symbol} ${interval}`, '/fapi/v1/klines', { symbol, interval, limit }, retries),
    /** @returns Map<symbol, price> — tüm semboller tek istekte */
    async prices() {
      const rows = await call(2, 'ticker/price', '/fapi/v2/ticker/price');
      const m = new Map();
      for (const r of rows) { const p = parseFloat(r.price); if (r.symbol && p > 0) m.set(r.symbol, p); }
      return m;
    },
    /** @returns Map<symbol, {rate, next, mark}> — funding oranı ve sonraki funding zamanı (tek istek) */
    async premium() {
      const rows = await call(10, 'premiumIndex', '/fapi/v1/premiumIndex');
      const m = new Map();
      for (const r of rows) {
        const rate = parseFloat(r.lastFundingRate);
        if (r.symbol && Number.isFinite(rate)) m.set(r.symbol, { rate, next: Number(r.nextFundingTime) || null, mark: parseFloat(r.markPrice) || null });
      }
      return m;
    },
    /** @returns Map<symbol, {vol, chg}> — 24s USDT hacmi ve % değişim */
    async tickers24h() {
      const rows = await call(40, 'ticker/24hr', '/fapi/v1/ticker/24hr');
      const m = new Map();
      for (const r of rows) m.set(r.symbol, { vol: parseFloat(r.quoteVolume) || 0, chg: parseFloat(r.priceChangePercent) });
      return m;
    },
  };
}

module.exports = { createBinance, cryptoPerpetuals, isTradfi, klineWeight };
