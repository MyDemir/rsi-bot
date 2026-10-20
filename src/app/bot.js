'use strict';

/**
 * Uygulama akışı
 *
 *   açılış     exchangeInfo → kripto perpetual listesi → her coin için 4h/12h/1d mumları (REST, hız sınırlı)
 *              + funding (premiumIndex) → şu an şartı sağlayanlar "verildi" sayılır (açılışta kart yağmuru yok)
 *   anlık      WebSocket !miniTicker@arr (saniyede bir, değişen coinler) → açık mumlar → RSI → sinyal → KART (coin başına ayrı)
 *              WebSocket !markPrice@arr@1s → funding oranı + sonraki funding zamanı
 *   mum kapanınca  30 sn sonra o mum REST'ten yeniden yüklenir (kesin kapanış)
 *   kopukluk   yeniden bağlanınca fiyat + funding REST'ten tamamlanır; kopuklukta mumu kapanan coinler
 *              mumlar kesinleşene kadar sinyal vermez (scalp-bot "kurtarma kilidi" mantığı)
 *   yedek      WebSocket 20 sn sessizse fiyatlar 15 sn'de bir REST'ten
 *   periyodik  liste (listeDk), 24s hacim (5 dk), REST karşılaştırması (5 dk), yeni/kaldırılan kontratlar (6 saat)
 */

const { Market } = require('../core/market');
const { createSignalEngine, activeTfs } = require('../core/signals');
const { cryptoPerpetuals } = require('../exchange/binance');
const { createStream } = require('../exchange/stream');
const chart = require('./chart');
const fmt = require('./format');

const COND_KEYS = new Set(['ustAktif', 'ustEsik', 'altAktif', 'altEsik', 'tf4h', 'tf12h', 'tf1d', 'anlik', 'rsiPeriod']);

function createApp({ cfg, binance, telegram, settings, logger = console, now = () => Date.now(), streamFactory = createStream }) {
  const market = new Market({ tfs: cfg.tfs, period: settings.get().rsiPeriod });
  const engine = createSignalEngine({ tfs: cfg.tfs });
  const failed = new Set();
  const resync = new Map();                 // "SYM|tf" → zaman
  const blocked = new Set();                // kopukluk sonrası mumları kesinleşene kadar sinyal vermeyenler
  const chartCache = new Map();             // "SYM|tf" → { at, candles }
  let tickers = new Map();                  // sym → { vol, chg }
  let funding = new Map();                  // sym → { rate, next, mark }
  let lastListSlot = null, stopped = false, loading = 0, fallback = false, stream = null, volumeFilterSkipped = false;
  const timers = [];
  const stats = { startedAt: now(), lastPriceAt: 0, lastWsAt: 0, cards: 0, cardsDay: null, cardsToday: 0, gaps: 0, priceErrors: 0, wsUpdates: 0 };

  const S = () => settings.get();
  const keys = () => activeTfs(cfg.tfs, S());
  const rsisOf = sym => market.rsi(sym, S().anlik);
  const ctx = () => ({ s: S(), tfs: cfg.tfs, keys: keys(), now: now(), tz: cfg.tz });

  // ── Yükleme ───────────────────────────────────────────────────────────────
  async function loadSymbol(sym) {
    const limit = market.klineLimit();
    for (const t of cfg.tfs) market.load(sym, t.key, await binance.klines(sym, t.key, limit), now());
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
    try {
      const m = await binance.tickers24h();
      for (const [k, v] of m) tickers.set(k, v);
    } catch (err) { logger.warn(`[24S] alınamadı: ${err.message}`); return; }
    if (volumeFilterSkipped && !stopped) {           // hacim verisi geldi → atlanan süzgeci şimdi uygula
      await refreshUniverse().catch(err => logger.error(`[EVREN] ${err.message}`));
    }
  }

  async function refreshFunding() {
    try {
      const m = await binance.premium();
      for (const [k, v] of m) funding.set(k, v);
    } catch (err) { logger.warn(`[FUNDING] alınamadı: ${err.message}`); }
  }

  async function refreshUniverse() {
    const info = await binance.exchangeInfo();
    let list = cryptoPerpetuals(info, cfg.excludeBases);
    const min = S().minHacimM * 1e6;
    volumeFilterSkipped = min > 0 && !tickers.size;
    if (volumeFilterSkipped) logger.warn('[EVREN] 24s hacim verisi yok — hacim süzgeci veri gelince uygulanacak');
    else if (min > 0) list = list.filter(sym => (tickers.get(sym)?.vol ?? 0) >= min);
    const want = new Set(list);
    for (const x of failed) if (!want.has(x)) failed.delete(x);
    const removed = market.symbols().filter(x => !want.has(x));
    for (const x of removed) { market.remove(x); engine.forget(x); blocked.delete(x); }
    const added = list.filter(x => !market.has(x));
    if (added.length || removed.length) logger.log(`[EVREN] ${list.length} coin (+${added.length} / −${removed.length})`);
    await loadMany(added);
    return { list, added, removed };
  }

  /** Yüklenemeyen coinleri yeniden dene (geçici Binance hatası coini saatlerce kör bırakmasın) */
  async function retryFailed() {
    if (!failed.size || loading > 0) return;
    const list = [...failed];
    await loadMany(list);
    const ok = list.filter(x => !failed.has(x));
    if (ok.length) logger.log(`[YÜKLE] yeniden denendi: ${ok.length}/${list.length} coin yüklendi${failed.size ? ` · ${failed.size} hâlâ hatalı` : ''}`);
  }

  // ── Fiyat → RSI → kart ───────────────────────────────────────────────────
  function applyPrice(sym, price, t, { gap = false } = {}) {
    const rolled = market.onPrice(sym, price, t);
    if (rolled.length) {
      for (const tf of rolled) resync.set(`${sym}|${tf}`, gap ? t : t + cfg.resyncDelayMs);
      if (gap) blocked.add(sym);           // kopuklukta mum kapandı → kesinleşene kadar sinyal yok
    }
    if (!market.ready(sym) || blocked.has(sym)) return;
    evaluate(sym, price);
  }

  function evaluate(sym, price = market.price(sym)) {
    const rsis = rsisOf(sym);
    for (const dir of engine.step(sym, rsis, S())) emitCard(dir, sym, rsis, price);
  }

  function emitCard(dir, sym, rsis, price) {
    const c = ctx();
    const day = new Date(c.now).toISOString().slice(0, 10);
    if (stats.cardsDay !== day) { stats.cardsDay = day; stats.cardsToday = 0; }
    stats.cards++; stats.cardsToday++;
    const text = fmt.cardText(dir, { sym, rsis, price, chg: tickers.get(sym)?.chg, funding: funding.get(sym) }, c);
    const tf = c.s.grafikTf;
    const photo = c.s.grafik ? () => chartPng(sym, tf, `RSI ${fmt.DIR[dir].name.toLowerCase()}`) : null;
    telegram.send(text, { kind: 'card', silent: !c.s.sesli, photo });
    logger.log(`[KART] ${sym} ${dir === 'up' ? 'aşırı alım' : 'aşırı satım'} · ${c.keys.map(k => `${k} ${fmt.r1(rsis[k])}`).join(' · ')}`);
  }

  /** Süre sınırlı söz: süre dolarsa hata (arkadaki istek sürer ama bekleyen beklemez) */
  function withTimeout(p, ms, label) {
    let h;
    return Promise.race([p, new Promise((_, rej) => { h = setTimeout(() => rej(new Error(`${label}: ${ms / 1000} sn içinde yanıt yok`)), ms); })]).finally(() => clearTimeout(h));
  }

  /**
   * Grafik: seçili dilimin mumları (1 REST isteği, 60 sn önbellek) → PNG. Gönderim anında çağrılır.
   * Telegram kuyruğu bunu beklediği için istek tekrar denenmez ve süre sınırlıdır; alınamazsa eski önbellek,
   * o da yoksa hata → kart grafiksiz gider.
   */
  async function chartPng(sym, tf, title = '') {
    const key = `${sym}|${tf}`, t = now();
    let hit = chartCache.get(key);
    if (!hit || t - hit.at > cfg.chartCacheMs) {
      try {
        const rows = await withTimeout(binance.klines(sym, tf, 150, { retries: 0 }), cfg.chartTimeoutMs ?? 8_000, `grafik ${sym} ${tf}`);
        hit = { at: t, candles: chart.toCandles(rows) };
        chartCache.delete(key);
        chartCache.set(key, hit);
        if (chartCache.size > 200) chartCache.delete(chartCache.keys().next().value);
      } catch (err) {
        if (!hit) throw err;
        logger.warn(`[GRAFİK] ${err.message} — önbellekteki mumlar kullanıldı`);
      }
    }
    const s = S();
    const cs = hit.candles.slice();
    const p = market.price(sym);
    if (cs.length && Number.isFinite(p)) {                // açık mumu anlık fiyatla güncelle
      const l = { ...cs[cs.length - 1], c: p };
      l.h = Math.max(l.h, p); l.l = Math.min(l.l, p);
      cs[cs.length - 1] = l;
    }
    return chart.renderChart({ symbol: sym, tf, candles: cs, period: s.rsiPeriod, ust: s.ustEsik, alt: s.altEsik, title, tz: cfg.tz });
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  function onData(name, data) {
    const t = now();
    if (name === '!miniTicker@arr') {
      stats.lastWsAt = t; stats.lastPriceAt = t;
      if (fallback) { fallback = false; logger.log('[VERİ] WebSocket geri geldi — REST yedeği kapatıldı'); }
      for (const d of data) {
        if (!market.has(d.s)) continue;
        const p = +d.c, o = +d.o;
        if (!(p > 0)) continue;
        const prev = tickers.get(d.s);
        tickers.set(d.s, { vol: +d.q || prev?.vol || 0, chg: o > 0 ? (p - o) / o * 100 : prev?.chg });
        stats.wsUpdates++;
        applyPrice(d.s, p, t);
      }
    } else if (name.startsWith('!markPrice@arr')) {
      for (const d of data) {
        const rate = parseFloat(d.r);
        if (d.s && Number.isFinite(rate)) funding.set(d.s, { rate, next: Number(d.T) || null, mark: parseFloat(d.p) || null });
      }
    }
  }

  async function restPrices({ gap = false } = {}) {
    let prices;
    try { prices = await binance.prices(); } catch (err) { stats.priceErrors++; logger.warn(`[FİYAT] REST alınamadı: ${err.message}`); return false; }
    const t = now();
    stats.lastPriceAt = Math.max(stats.lastPriceAt, t);
    for (const sym of market.symbols()) {
      const p = prices.get(sym);
      if (p != null) applyPrice(sym, p, t, { gap });
    }
    return true;
  }

  async function onGap(downSince) {
    stats.gaps++;
    const sec = Math.round((now() - downSince) / 1000);
    logger.warn(`[VERİ] WebSocket ${sec} sn kesildi — fiyat ve funding REST'ten tamamlanıyor`);
    await restPrices({ gap: true });
    await refreshFunding();
    if (blocked.size) logger.log(`[VERİ] ${blocked.size} coinde kopuklukta mum kapandı — mumlar kesinleşene kadar sinyal kilitli`);
  }

  async function fallbackTick() {
    const silent = stream ? stream.silenceMs() : Infinity;
    if (silent <= cfg.fallbackAfterMs) return;
    if (!fallback) { fallback = true; logger.warn(`[VERİ] WebSocket ${Math.round(silent / 1000)} sn sessiz — fiyatlar REST'ten (yedek)`); }
    await restPrices({ gap: true });
  }

  async function resyncTick() {
    const t = now();
    const due = [...resync.entries()].filter(([, at]) => at <= t).slice(0, 40);
    const touched = new Set();
    for (const [k] of due) {
      resync.delete(k);
      const [sym, tf] = k.split('|');
      if (!market.has(sym)) continue;
      try { market.load(sym, tf, await binance.klines(sym, tf, market.klineLimit()), now()); touched.add(sym); }
      catch (err) { logger.warn(`[KESİNLEŞTİR] ${sym} ${tf}: ${err.message}`); resync.set(k, now() + 30_000); }
    }
    for (const sym of touched) {
      if (!blocked.has(sym) || [...resync.keys()].some(k => k.startsWith(`${sym}|`))) continue;
      blocked.delete(sym);                    // tüm mumları kesin → kilit kalkar, şart hemen değerlendirilir
      if (market.ready(sym)) evaluate(sym);
    }
  }

  // ── Liste / durum ────────────────────────────────────────────────────────
  const strength = (dir, rsis, ks) => (dir === 'up' ? Math.min(...ks.map(k => rsis[k])) : -Math.max(...ks.map(k => rsis[k])));

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

  /** /rsi BTC → { text, photo? } ya da null */
  function coinReply(sym) {
    if (!market.ready(sym)) return null;
    const rsis = rsisOf(sym), s = S();
    const text = fmt.coinText({ sym, rsis, price: market.price(sym), chg: tickers.get(sym)?.chg, funding: funding.get(sym), match: engine.matches(rsis, s) }, ctx());
    return { text, photo: s.grafik ? () => chartPng(sym, s.grafikTf) : null };
  }

  function readyCount() { let n = 0; for (const x of market.symbols()) if (market.ready(x)) n++; return n; }

  function statusText() {
    const t = now();
    const up = Math.round((t - stats.startedAt) / 60_000);
    const ws = stats.lastWsAt ? Math.round((t - stats.lastWsAt) / 1000) : null;
    const mem = Math.round(process.memoryUsage().rss / 1048576);
    const tg = telegram.stats || {};
    return [
      `🟢 <b>RSI botu</b> · ${Math.floor(up / 60)} sa ${up % 60} dk çalışıyor`,
      `Coin: ${market.symbols().length} izleniyor · ${readyCount()} hazır${loading > 0 ? ` · ${loading} yükleniyor` : ''}${failed.size ? ` · ${failed.size} hata` : ''}${blocked.size ? ` · ${blocked.size} kesinleşiyor` : ''}`,
      `Veri: ${fallback ? '⚠️ REST yedeği (WebSocket sessiz)' : ws == null ? 'WebSocket bağlanıyor' : `✅ WebSocket · son güncelleme ${ws} sn önce`}${stats.gaps ? ` · ${stats.gaps} kopukluk tamamlandı` : ''}`,
      `Binance ağırlık ${binance.stats.usedWeight}/2400 dk · funding ${funding.size} coin`,
      `Bugün ${stats.cardsToday} kart · Telegram kuyruğu ${telegram.queueLength()}${tg.droppedExpired ? ` · ${tg.droppedExpired} bayat atlandı` : ''} · bellek ${mem} MB`,
      '',
      fmt.listSections(lists(), { ...ctx(), max: 0 }).replace(/\n\n/g, '\n'),
    ].join('\n');
  }

  // ── Ayar değişince ───────────────────────────────────────────────────────
  let changeTimer = null, changed = new Set();
  settings.onChange(key => {
    // Şart değişikliği ANINDA uygulanır: şu an şartı sağlayanlar "verildi" sayılır — aradaki fiyat
    // güncellemesi eski durumla yeni eşiği karıştırıp kart üretmesin.
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
      telegram.send(`⚙️ <b>Ayar değişti</b> — şu an şartı sağlayanlar (bunlar için ayrıca kart gelmez, şarta yeni girenler için gelir):\n\n${fmt.listSections(lists(), ctx())}`, { silent: true });
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
    await Promise.all([refreshTickers(), refreshFunding()]);
    const { list } = await refreshUniverse();
    logger.log(`[BOT] ${list.length} kripto vadeli kontrat · ${readyCount()} hazır${failed.size ? ` · ${failed.size} yüklenemedi` : ''}`);
    await restPrices();
    stream = streamFactory({ onData, onGap, options: { url: cfg.wsUrl, staleMs: cfg.wsStaleMs }, logger });
    stream.start();
    every(cfg.priceEveryMs, fallbackTick, 'YEDEK');
    every(2_000, resyncTick, 'KESİNLEŞTİR');
    every(cfg.retryFailedEveryMs ?? 3 * 60_000, retryFailed, 'YÜKLE');
    every(20_000, listTick, 'LİSTE');
    every(cfg.tickersEveryMs, refreshTickers, '24S');
    every(cfg.reconcileEveryMs, async () => { if (!fallback) await restPrices(); await refreshFunding(); }, 'KARŞILAŞTIR');
    every(cfg.universeEveryMs, async () => { await refreshUniverse(); }, 'EVREN');
    every(cfg.heartbeatMs, () => logger.log(`[NABIZ] ${readyCount()}/${market.symbols().length} hazır · ${fallback ? 'REST yedeği' : `WS ${stats.lastWsAt ? Math.round((now() - stats.lastWsAt) / 1000) : '-'} sn`} · ${stats.wsUpdates} güncelleme · ${stats.cards} kart · tg kuyruk ${telegram.queueLength()} · ${Math.round(process.memoryUsage().rss / 1048576)} MB`), 'NABIZ');
    listTick();
    telegram.send(`🟢 <b>RSI botu hazır</b> — ${readyCount()} kripto vadeli kontrat izleniyor\n\n${fmt.listSections(lists(), ctx())}\n\n<i>Listedekiler için ayrıca kart gelmez; şarta yeni girenler için gelir. Ayarlar: /ayarlar</i>`, { silent: true });
  }

  function stop() {
    stopped = true;
    stream?.stop();
    for (const h of timers) clearInterval(h);
    clearTimeout(changeTimer);
  }

  return {
    start, stop, onData, onGap, restPrices, fallbackTick, listTick, resyncTick, refreshUniverse, refreshTickers, retryFailed, lists, listText, coinReply, statusText, chartPng,
    market, engine, stats, blocked, funding, failed, _resync: resync, get stream() { return stream; },
  };
}

module.exports = { createApp };
