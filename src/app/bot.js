'use strict';

/**
 * Uygulama akışı:
 *
 *   açılış      exchangeInfo → kripto perpetual listesi → her coin için 4h/12h/1d mumları (REST, hız sınırlı)
 *               → şu an şartı sağlayanlar "verildi" sayılır (açılışta sinyal yağmuru olmaz) → hazır mesajı + liste
 *   her 15 sn   tüm fiyatlar tek istekte → açık mumlar güncellenir → RSI → sinyal motoru
 *   5 sn'de bir aynı anda oluşan sinyaller yön başına tek mesajda gönderilir
 *   mum kapanışı → 30 sn sonra o mum REST'ten yeniden yüklenir (kesin kapanış)
 *   periyodik   liste (listeDk), 24s hacim/değişim (5 dk), yeni/kaldırılan kontratlar (6 saat)
 */

const { Market } = require('../core/market');
const { createSignalEngine, activeTfs } = require('../core/signals');
const { cryptoPerpetuals } = require('../exchange/binance');
const fmt = require('./format');

const COND_KEYS = new Set(['ustAktif', 'ustEsik', 'altAktif', 'altEsik', 'tf4h', 'tf12h', 'tf1d', 'anlik', 'rsiPeriod']);

function createApp({ cfg, binance, telegram, settings, logger = console, now = () => Date.now() }) {
  const market = new Market({ tfs: cfg.tfs, period: settings.get().rsiPeriod });
  const engine = createSignalEngine({ tfs: cfg.tfs });
  const failed = new Set();
  const resync = new Map();                 // "SYM|tf" → zaman
  const pending = { up: [], down: [] };
  let tickers = new Map();
  let lastListSlot = null, stopped = false, loading = 0;
  const timers = [];
  const stats = { startedAt: now(), lastPriceAt: 0, signals: 0, signalsDay: null, signalsToday: 0, priceErrors: 0 };

  const S = () => settings.get();
  const keys = () => activeTfs(cfg.tfs, S());
  const rsisOf = sym => market.rsi(sym, S().anlik);
  const ctx = () => ({ s: S(), tfs: cfg.tfs, keys: keys(), now: now(), tz: cfg.tz });

  // ── Yükleme ───────────────────────────────────────────────────────────────
  async function loadSymbol(sym) {
    const limit = market.klineLimit();
    for (const t of cfg.tfs) {
      const rows = await binance.klines(sym, t.key, limit);
      market.load(sym, t.key, rows, now());
    }
  }

  async function loadMany(list) {
    let i = 0;
    loading += list.length;
    const worker = async () => {
      while (i < list.length && !stopped) {
        const sym = list[i++];
        try {
          await loadSymbol(sym);
          failed.delete(sym);
          engine.prime(sym, rsisOf(sym), S());
        } catch (err) {
          failed.add(sym); market.remove(sym);
          logger.warn(`[YÜKLE] ${sym}: ${err.message}`);
        } finally { loading--; }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  async function refreshTickers() {
    try { tickers = await binance.tickers24h(); } catch (err) { logger.warn(`[24S] alınamadı: ${err.message}`); }
  }

  async function refreshUniverse() {
    const info = await binance.exchangeInfo();
    let list = cryptoPerpetuals(info, cfg.excludeBases);
    const min = S().minHacimM * 1e6;
    if (min > 0) list = list.filter(sym => (tickers.get(sym)?.vol ?? 0) >= min);
    const want = new Set(list);
    const removed = market.symbols().filter(x => !want.has(x));
    for (const x of removed) { market.remove(x); engine.forget(x); }
    const added = list.filter(x => !market.has(x));
    if (added.length || removed.length) logger.log(`[EVREN] ${list.length} coin (+${added.length} / −${removed.length})`);
    await loadMany(added);
    return { list, added, removed };
  }

  // ── Fiyat → RSI → sinyal ─────────────────────────────────────────────────
  async function priceTick() {
    let prices;
    try { prices = await binance.prices(); } catch (err) { stats.priceErrors++; logger.warn(`[FİYAT] alınamadı: ${err.message}`); return; }
    const t = now();
    stats.lastPriceAt = t;
    const s = S();
    for (const sym of market.symbols()) {
      const p = prices.get(sym);
      if (p == null) continue;
      for (const tf of market.onPrice(sym, p, t)) resync.set(`${sym}|${tf}`, t + cfg.resyncDelayMs);
      if (!market.ready(sym)) continue;
      const rsis = rsisOf(sym);
      for (const dir of engine.step(sym, rsis, s)) pending[dir].push({ sym, rsis, price: p, chg: tickers.get(sym)?.chg });
    }
  }

  const strength = (dir, rsis, ks) => (dir === 'up' ? Math.min(...ks.map(k => rsis[k])) : -Math.max(...ks.map(k => rsis[k])));

  function flushSignals() {
    const c = ctx();
    const day = new Date(c.now).toISOString().slice(0, 10);
    if (stats.signalsDay !== day) { stats.signalsDay = day; stats.signalsToday = 0; }
    for (const dir of ['up', 'down']) {
      const items = pending[dir].splice(0);
      if (!items.length) continue;
      items.sort((a, b) => strength(dir, b.rsis, c.keys) - strength(dir, a.rsis, c.keys));
      telegram.send(fmt.signalText(dir, items, c), { silent: !c.s.sesli });
      stats.signals += items.length; stats.signalsToday += items.length;
      logger.log(`[SİNYAL] ${dir === 'up' ? 'aşırı alım' : 'aşırı satım'}: ${items.map(x => x.sym).join(', ')}`);
    }
  }

  async function resyncTick() {
    const t = now();
    const due = [...resync.entries()].filter(([, at]) => at <= t).slice(0, 40);
    for (const [k] of due) {
      resync.delete(k);
      const [sym, tf] = k.split('|');
      if (!market.has(sym)) continue;
      try { market.load(sym, tf, await binance.klines(sym, tf, market.klineLimit()), now()); } catch (err) { logger.warn(`[KESİNLEŞTİR] ${sym} ${tf}: ${err.message}`); }
    }
  }

  // ── Liste ────────────────────────────────────────────────────────────────
  function lists() {
    const s = S(), ks = keys();
    const up = [], down = [];
    for (const sym of market.symbols()) {
      if (!market.ready(sym)) continue;
      const rsis = rsisOf(sym);
      const m = engine.matches(rsis, s);
      if (m.up) up.push({ sym, rsis });
      if (m.down) down.push({ sym, rsis });
    }
    up.sort((a, b) => strength('up', b.rsis, ks) - strength('up', a.rsis, ks));
    down.sort((a, b) => strength('down', b.rsis, ks) - strength('down', a.rsis, ks));
    return { up, down };
  }

  const listText = () => fmt.listText(lists(), ctx());

  function listTick() {
    const s = S();
    if (!s.listeDk) { lastListSlot = null; return; }
    const slot = Math.floor(now() / (s.listeDk * 60_000));
    if (lastListSlot != null && slot !== lastListSlot) telegram.send(listText(), { silent: true });
    lastListSlot = slot;
  }

  function coinText(sym) {
    if (!market.ready(sym)) return null;
    const rsis = rsisOf(sym);
    return fmt.coinText({ sym, rsis, price: market.price(sym), chg: tickers.get(sym)?.chg, match: engine.matches(rsis, S()) }, ctx());
  }

  function readyCount() { let n = 0; for (const x of market.symbols()) if (market.ready(x)) n++; return n; }

  function statusText() {
    const t = now();
    const up = Math.round((t - stats.startedAt) / 60_000);
    const ago = stats.lastPriceAt ? Math.round((t - stats.lastPriceAt) / 1000) : null;
    const mem = Math.round(process.memoryUsage().rss / 1048576);
    return [
      `🟢 <b>RSI botu</b> · ${Math.floor(up / 60)} sa ${up % 60} dk çalışıyor`,
      `Coin: ${market.symbols().length} izleniyor · ${readyCount()} hazır${loading > 0 ? ` · ${loading} yükleniyor` : ''}${failed.size ? ` · ${failed.size} hata` : ''}`,
      `Son fiyat: ${ago == null ? 'henüz yok' : `${ago} sn önce`}${ago != null && ago > 90 ? ' ⚠️' : ''} · Binance ağırlık ${binance.stats.usedWeight}/2400 dk`,
      `Bugün ${stats.signalsToday} sinyal · Telegram kuyruğu ${telegram.queueLength()} · bellek ${mem} MB`,
      '',
      `${fmt.listSections(lists(), { ...ctx(), max: 0 }).replace(/\n\n/g, '\n')}`,
    ].join('\n');
  }

  // ── Ayar değişince ───────────────────────────────────────────────────────
  let changeTimer = null, changed = new Set();
  settings.onChange(key => {
    // Şart değişikliği ANINDA uygulanır: şu an şartı sağlayanlar "verildi" sayılır — aradaki fiyat
    // güncellemesi eski durumla yeni eşiği karıştırıp sinyal üretmesin.
    if (key === 'rsiPeriod') {
      market.setPeriod(S().rsiPeriod);
      const at = now() + 1000;     // uzun periyot daha çok mum ister → tüm mumlar yeni sayıyla yeniden yüklenir
      for (const sym of market.symbols()) for (const t of cfg.tfs) resync.set(`${sym}|${t.key}`, at);
    }
    if (key === 'listeDk') lastListSlot = null;
    if (COND_KEYS.has(key)) for (const sym of market.symbols()) if (market.ready(sym)) engine.prime(sym, rsisOf(sym), S());
    changed.add(key);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(applyChanges, cfg.settingsDebounceMs ?? 1500);   // bilgi mesajı: art arda dokunuşlarda bir kez
  });

  async function applyChanges() {
    const ks = [...changed]; changed = new Set();
    if (ks.includes('minHacimM')) { await refreshTickers(); await refreshUniverse().catch(err => logger.error(`[EVREN] ${err.message}`)); }
    if (ks.some(k => COND_KEYS.has(k))) {
      telegram.send(`⚙️ <b>Ayar değişti</b> — şu an şartı sağlayanlar (bunlar için ayrıca sinyal gelmez, yeni girenler için gelir):\n\n${fmt.listSections(lists(), ctx())}`, { silent: true });
    }
  }

  // ── Başlat / durdur ──────────────────────────────────────────────────────
  function every(ms, fn, label) {
    let busy = false;
    const h = setInterval(async () => {
      if (busy || stopped) return;
      busy = true;
      try { await fn(); } catch (err) { logger.error(`[${label}] ${err.message}`); } finally { busy = false; }
    }, ms);
    timers.push(h);
  }

  async function start() {
    await refreshTickers();
    const { list } = await refreshUniverse();
    logger.log(`[BOT] ${list.length} kripto vadeli kontrat · ${readyCount()} hazır${failed.size ? ` · ${failed.size} yüklenemedi` : ''}`);
    await priceTick();
    every(cfg.priceEveryMs, priceTick, 'FİYAT');
    every(cfg.batchMs, flushSignals, 'GÖNDER');
    every(2_000, resyncTick, 'KESİNLEŞTİR');
    every(20_000, listTick, 'LİSTE');
    every(cfg.tickersEveryMs, refreshTickers, '24S');
    every(cfg.universeEveryMs, async () => { await refreshUniverse(); const r = [...failed]; if (r.length) await loadMany(r.filter(x => !market.has(x))); }, 'EVREN');
    every(cfg.heartbeatMs ?? 5 * 60_000, () => logger.log(`[NABIZ] ${readyCount()}/${market.symbols().length} hazır · son fiyat ${stats.lastPriceAt ? Math.round((now() - stats.lastPriceAt) / 1000) : '-'} sn önce · ${stats.signals} sinyal · tg kuyruk ${telegram.queueLength()} · ${Math.round(process.memoryUsage().rss / 1048576)} MB`), 'NABIZ');
    listTick();
    telegram.send(`🟢 <b>RSI botu hazır</b> — ${readyCount()} kripto vadeli kontrat izleniyor\n\n${fmt.listSections(lists(), ctx())}\n\n<i>Listedekiler için ayrıca sinyal gelmez; şarta yeni girenler için gelir. Ayarlar: /ayarlar</i>`, { silent: true });
  }

  function stop() {
    stopped = true;
    for (const h of timers) clearInterval(h);
    clearTimeout(changeTimer);
  }

  return { start, stop, priceTick, flushSignals, listTick, resyncTick, refreshUniverse, lists, listText, coinText, statusText, market, engine, stats, _pending: pending, _resync: resync };
}

module.exports = { createApp };
