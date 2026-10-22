'use strict';

/**
 * Binance USDⓈ-M WebSocket istemcisi — scalp-bot streamClient.js altyapısından.
 *
 * Tüm piyasa için yalnız İKİ stream, TEK bağlantı (yük yok):
 *   !miniTicker@arr      saniyede bir, yalnız değişen coinler: son fiyat (c), 24s açılış (o), hacim (q)
 *   !markPrice@arr@1s    saniyede bir: funding oranı (r), sonraki funding zamanı (T), mark fiyat (p)
 * (Kline stream'leri coin başına saniyede 4 mesaj → 450 coin × 3 dilim ≈ 5000 mesaj/sn; burada ≈ 2 mesaj/sn.)
 *
 *   • Adres: wss://fstream.binance.com/market/stream (2026-04-23 public / market / private ayrımı sonrası)
 *   • Binance'in ping'ine 'ws' otomatik pong döner; 24 saatlik zorunlu kopuş otomatik yeniden bağlanır
 *   • Watchdog: staleMs boyunca mesaj yoksa bağlantı koparılıp yeniden kurulur ("bağlı ama veri yok")
 *   • Yeniden bağlanınca onGap(downSince) → uygulama REST ile boşluğu kapatır
 *   • Üstel geri çekilme 1 sn → 30 sn
 *   • Gecikme: mesajın Binance'te üretildiği an (E) ile buraya ulaştığı an arasındaki fark ölçülür
 *     (ağ + event loop kuyruğu). scalp-bot'taki "yerel gecikme" ölçümü — 1006 kopuşlarının ve geç
 *     verinin sebebi Binance mı, makine mi, ayırmak için. takeWindow() pencereyi verip sıfırlar.
 */

const WebSocket = require('ws');

const DEFAULTS = {
  url: process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/market/stream',
  streams: ['!miniTicker@arr', '!markPrice@arr@1s'],
  staleMs: 30_000,
  watchdogEveryMs: 5_000,
  minBackoffMs: 1_000,
  maxBackoffMs: 30_000,
};

/**
 * @param {object} p
 * @param {(stream:string, data:any)=>void} p.onData
 * @param {(downSince:number)=>void|Promise} [p.onGap]  yeniden bağlanıp ilk veri gelince
 */
function createStream({ onData, onGap = () => {}, options = {}, logger = console }) {
  const opt = { ...DEFAULTS, ...options };
  const st = { ws: null, state: 'idle', lastMsgAt: 0, downSince: null, backoffMs: opt.minBackoffMs, timers: [] };
  const stats = { messages: 0, reconnects: 0, parseErrors: 0, connectedAt: 0 };
  const newWin = () => ({ messages: 0, reconnects: 0, lagSum: 0, lagN: 0, lagMax: 0, from: Date.now() });
  let win = newWin();
  let stopped = true, watchdog = null;

  function checkGap() {
    if (st.downSince == null) return;
    const since = st.downSince;
    st.downSince = null;
    st.backoffMs = opt.minBackoffMs;
    try {
      const r = onGap(since);
      if (r?.catch) r.catch(e => logger.error(`[WS] onGap hatası: ${e?.message || e}`));
    } catch (e) { logger.error(`[WS] onGap hatası: ${e.message}`); }
  }

  function handle(raw) {
    st.lastMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { stats.parseErrors++; return; }
    if (!msg?.stream || msg.data == null) return;
    stats.messages++; win.messages++;
    // Dizi akışlarında her öğe aynı E'yi taşır; ilki yeter
    const e = Number((Array.isArray(msg.data) ? msg.data[0] : msg.data)?.E);
    if (e > 0) {
      const lag = Math.max(0, st.lastMsgAt - e);    // saat farkı eksiye düşürmesin
      win.lagSum += lag; win.lagN++;
      if (lag > win.lagMax) win.lagMax = lag;
    }
    checkGap();
    try { onData(msg.stream, msg.data); } catch (e) { logger.error(`[WS] işleme hatası (${msg.stream}): ${e.message}`); }
  }

  function connect() {
    if (stopped) return;
    st.state = 'connecting';
    const ws = new WebSocket(`${opt.url}?streams=${opt.streams.join('/')}`, { handshakeTimeout: 15_000 });
    st.ws = ws;
    ws.on('open', () => {
      st.state = 'open'; st.lastMsgAt = Date.now(); stats.connectedAt = Date.now();
      logger.log(`[WS] Bağlandı — ${opt.streams.join(', ')}`);
    });
    ws.on('message', handle);
    ws.on('error', err => logger.error(`[WS] Hata: ${err.message}`));
    ws.on('close', code => {
      if (st.ws !== ws) return;                 // eski sokete ait gecikmiş olay
      st.timers.forEach(clearTimeout); st.timers = [];
      st.state = 'closed';
      if (st.downSince == null) st.downSince = st.lastMsgAt || Date.now();
      if (stopped) return;
      const delay = st.backoffMs;
      st.backoffMs = Math.min(st.backoffMs * 2, opt.maxBackoffMs);
      stats.reconnects++; win.reconnects++;
      logger.warn(`[WS] Bağlantı kapandı (kod ${code}) — ${Math.round(delay / 1000)} sn sonra yeniden bağlanılacak`);
      st.timers.push(setTimeout(connect, delay));
    });
  }

  function checkStale() {
    if (st.state === 'open' && Date.now() - st.lastMsgAt > opt.staleMs) {
      logger.warn(`[WS] ${Math.round((Date.now() - st.lastMsgAt) / 1000)} sn'dir veri yok — bağlantı yenileniyor`);
      st.downSince = st.downSince ?? st.lastMsgAt;
      st.ws.terminate();                         // 'close' → yeniden bağlan
    }
  }

  return {
    start() {
      stopped = false;
      st.downSince = null;
      connect();
      watchdog = setInterval(checkStale, opt.watchdogEveryMs);
    },
    stop() {
      stopped = true;
      clearInterval(watchdog);
      st.timers.forEach(clearTimeout); st.timers = [];
      if (st.ws) { st.ws.removeAllListeners('close'); st.ws.terminate(); }
      st.state = 'closed';
    },
    /** Son mesajdan bu yana geçen süre (ms); hiç bağlanmadıysa Infinity */
    silenceMs: () => (st.lastMsgAt ? Date.now() - st.lastMsgAt : Infinity),
    isOpen: () => st.state === 'open',
    stats,
    /** Nabız için son pencere (mesaj, yeniden bağlanma, gecikme ort/en fazla ms) — döndürür ve sıfırlar */
    takeWindow() {
      const w = win;
      win = newWin();
      return { messages: w.messages, reconnects: w.reconnects, lagAvgMs: w.lagN ? Math.round(w.lagSum / w.lagN) : null, lagMaxMs: w.lagN ? Math.round(w.lagMax) : null, windowMs: Date.now() - w.from };
    },
  };
}

module.exports = { createStream };
