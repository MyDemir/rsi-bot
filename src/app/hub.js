'use strict';

/**
 * İzleme paneline nabız (isteğe bağlı) — scalp-bot paneli /api/external-bots/heartbeat ucuna uyumlu.
 * HUB_URL ve HUB_KEY tanımlı değilse hiçbir şey gönderilmez.
 *
 *   • Panel 120 sn nabız almazsa botu çevrimdışı sayar → varsayılan 60 sn aralık
 *   • Gövde panelin doğrulamasına uygun: id ≤ 64 (harf, rakam, _ . : -), ad ≤ 80, en fazla 20 metrik (değer ≤ 80)
 *   • Sorun sürdükçe durum 'error' gider; açıklama (error) yalnız sorun ilk görüldüğünde gönderilir —
 *     panel her error'u kalıcı günlüğe yazdığı için dakikada bir aynı satır birikmesin
 *   • Gönderilemezse bir kez uyarı, düzelince bir kez bilgi (log taşmaz); anahtar hiçbir log satırına yazılmaz
 */

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const clip = (v, n) => String(v ?? '').slice(0, n);

/**
 * @param {object} p
 * @param {() => {status:string, problem:string|null, telegram:string|null, lastSignal:string|null, metrics:object}} p.report
 */
function createHub({ url, key, id = 'rsi-bot', name = 'RSI Botu', intervalMs = 60_000, report, logger = console }) {
  if (!url || !key) return null;
  if (key.length < 16) { logger.warn('[PANEL] HUB_KEY en az 16 karakter olmalı — nabız gönderilmeyecek'); return null; }
  if (!ID_RE.test(id)) { logger.warn(`[PANEL] HUB_BOT_ID geçersiz ("${clip(id, 70)}") — harf, rakam, _ . : - ve en fazla 64 karakter`); return null; }

  let timer = null, lastProblem = null, failing = false;

  async function post(body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status}${j.error ? ` (${clip(j.error, 120)})` : ''}`);
    }
  }

  function payload(r) {
    const metrics = Object.fromEntries(Object.entries(r.metrics || {}).slice(0, 20).map(([k, v]) => [clip(k, 40), clip(v, 80)]));
    const body = { id, name: clip(name, 80), status: r.status, metrics };
    if (r.telegram) body.telegram = clip(r.telegram, 64);
    if (r.lastSignal) body.lastSignal = clip(r.lastSignal, 200);
    if (r.problem && r.problem !== lastProblem) body.error = clip(r.problem, 300);     // yalnız yeni sorunda
    lastProblem = r.problem || null;
    return body;
  }

  async function beat(override) {
    let body;
    try { body = payload({ ...report(), ...override }); } catch (err) { logger.warn(`[PANEL] durum hazırlanamadı: ${err.message}`); return false; }
    try {
      await post(body);
      if (failing) { failing = false; logger.log('[PANEL] nabız yeniden gönderiliyor'); }
      return true;
    } catch (err) {
      if (body.error) lastProblem = null;                // sorun açıklaması ulaşmadı → sonraki nabızda tekrar
      if (!failing) { failing = true; logger.warn(`[PANEL] nabız gönderilemedi: ${err.name === 'TimeoutError' ? 'zaman aşımı' : err.message}`); }
      return false;
    }
  }

  return {
    start() {
      logger.log(`[PANEL] nabız açık — ${id}, ${Math.round(intervalMs / 1000)} sn aralık`);
      beat();
      timer = setInterval(beat, intervalMs);
      timer.unref?.();
    },
    /** Kapanışta: paneli bekletmeden 'offline' bildir */
    async stop() {
      clearInterval(timer);
      await beat({ status: 'offline', problem: null });
    },
    beat,
  };
}

module.exports = { createHub };
