'use strict';

/**
 * Telegram istemcisi — scalp-bot telegram.js altyapısından, test edilebilir fabrika biçiminde.
 * Node'un yerleşik fetch'i; harici kütüphane yok.
 *
 *   • Yetki: komutlar yalnız TELEGRAM_CHAT_ID sohbetinden ya da yöneticinin bota özel mesajından
 *   • Hız: grupta dakikada 20 mesaj sınırı → mesajlar arası ≥ minIntervalMs
 *   • 429: Telegram'ın verdiği retry_after kadar bekleyip TEKRAR dener (sinyal kaybolmaz)
 *   • 4096 karakteri aşan mesaj satır sınırından bölünür
 *   • Konu silinmişse mesaj genel akışa düşer; 409 (aynı token'la ikinci kopya) açık uyarı
 *   • Kuyruk sınırı (bellek), bayat kart atlanır (TTL), komut yanıtları kartların önüne geçer,
 *     2 dk'dan uzun bekleyen karta "gecikmeli" satırı (scalp-bot telegram.js'ten)
 *   • Fotoğraflı kart: grafik gönderim ANINDA çizilir (kuyrukta PNG birikmez); çizilemezse metin gider
 *   • Token hiçbir log satırına yazılmaz
 */

const MAX_LEN = 4000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class TelegramError extends Error {
  constructor(message, code, retryAfter) { super(message); this.code = code; this.retryAfter = retryAfter; }
}

/** Uzun metni satır sınırından parçalara böl */
function splitText(text, max = MAX_LEN) {
  if (text.length <= max) return [text];
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    const add = cur ? `${cur}\n${line}` : line;
    if (add.length > max && cur) { out.push(cur); cur = line.slice(0, max); } else cur = add.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

const CAPTION_MAX = 1024;
const LATE_MS = 2 * 60_000;
/** Görünen metin uzunluğu (etiketler hariç) — fotoğraf açıklaması sınırı için.
 *  multipart gönderimde satır sonları \r\n olur → her satır sonu 2 karakter sayılır (scalp-bot'taki gibi). */
const visibleLen = html => {
  const t = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return t.length + (t.match(/\n/g) || []).length;
};

function createTelegram({ apiBase = 'https://api.telegram.org', token, chatId, threadId = null, adminIds = [], minIntervalMs = 3100, maxQueue = 300, cardTtlMs = 20 * 60_000, logger = console } = {}) {
  const CHAT = String(chatId ?? '');

  async function api(method, body, timeoutMs = 15_000) {
    let res;
    try {
      res = await fetch(`${apiBase}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TelegramError(`ağ hatası (${err.name === 'TimeoutError' ? 'zaman aşımı' : err.cause?.code || err.message})`, 0);
    }
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) throw new TelegramError(data.description || `HTTP ${res.status}`, data.error_code ?? res.status, data.parameters?.retry_after);
    return data.result;
  }

  /** sendPhoto (multipart, Node'un yerleşik FormData/Blob'u) */
  async function apiPhoto(fields, png, timeoutMs = 30_000) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    fd.append('photo', new Blob([png], { type: 'image/png' }), 'grafik.png');
    let res;
    try {
      res = await fetch(`${apiBase}/bot${token}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new TelegramError(`ağ hatası (${err.name === 'TimeoutError' ? 'zaman aşımı' : err.cause?.code || err.message})`, 0);
    }
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) throw new TelegramError(data.description || `HTTP ${res.status}`, data.error_code ?? res.status, data.parameters?.retry_after);
    return data.result;
  }

  // ── Gönderim kuyruğu ─────────────────────────────────────────────────────
  const queue = [];
  let pumping = false, lastSentAt = 0;
  const stats = { sent: 0, failed: 0, retried429: 0, droppedOverflow: 0, droppedExpired: 0, photoFallback: 0, maxWaitMs: 0 };

  function push(item) {
    if (queue.length >= maxQueue) {                       // bellek koruması: önce en eski kart düşer
      const i = queue.findIndex(q => q.kind !== 'reply');
      if (i < 0 && item.kind !== 'reply') { stats.droppedOverflow++; logger.warn(`[TELEGRAM] kuyruk dolu (${maxQueue}) — yeni mesaj atlandı`); return; }
      queue.splice(i < 0 ? 0 : i, 1); stats.droppedOverflow++;
      logger.warn(`[TELEGRAM] kuyruk dolu (${maxQueue}) — en eski kart düşürüldü`);
    }
    if (item.kind === 'reply') {                          // komut yanıtları kartların önüne
      let i = 0;
      while (i < queue.length && queue[i].kind === 'reply') i++;
      queue.splice(i, 0, item);
    } else queue.push(item);
  }

  /** @param {object} extra { kind: 'card'|'reply'|'info', keyboard, silent, thread, photo: Buffer | () => Promise<Buffer|null> } */
  function enqueue(chat, text, extra = {}) {
    const kind = extra.kind || 'info';
    const parts = extra.photo ? [text] : splitText(text);
    parts.forEach((t, i) => push({ chat, text: t, attempts: 0, createdAt: Date.now(), ...extra, kind, ...(i < parts.length - 1 ? { keyboard: null } : {}) }));
    pump();
  }

  async function sendItem(item, body) {
    if (item.photo && !item.noPhoto) {
      let png = null;
      try { png = typeof item.photo === 'function' ? await item.photo() : item.photo; } catch (err) { logger.warn(`[TELEGRAM] grafik hazırlanamadı: ${err.message}`); }
      if (png && visibleLen(body.text) <= CAPTION_MAX) {
        const { text, link_preview_options: _lp, ...rest } = body;
        return apiPhoto({ ...rest, caption: text }, png);
      }
      if (!png) stats.photoFallback++;
    }
    return api('sendMessage', body);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const wait = lastSentAt + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        const item = queue.shift();
        const waited = Date.now() - item.createdAt;
        if (waited > stats.maxWaitMs) stats.maxWaitMs = waited;
        if (item.kind === 'card' && waited > cardTtlMs) {     // piyasa için bayat — gönderme
          stats.droppedExpired++;
          logger.warn(`[TELEGRAM] ${Math.round(waited / 60000)} dk bekleyen kart atlandı (bayat): ${item.text.slice(0, 40).replace(/\n/g, ' ')}`);
          continue;
        }
        try {
          const late = item.kind === 'card' && waited > LATE_MS ? `⏳ <i>gecikmeli (${Math.round(waited / 60000)} dk kuyrukta bekledi)</i>\n` : '';
          const body = { chat_id: item.chat, text: late + item.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
          if (item.thread) body.message_thread_id = Number(item.thread);
          if (item.keyboard) body.reply_markup = { inline_keyboard: item.keyboard };
          if (item.silent) body.disable_notification = true;
          await sendItem(item, body);
          stats.sent++;
          lastSentAt = Date.now();
        } catch (err) {
          lastSentAt = Date.now();
          if (err.code === 429) {
            const sec = err.retryAfter ?? 5;
            stats.retried429++;
            logger.warn(`[TELEGRAM] 429 hız sınırı — ${sec} sn sonra tekrar (kuyrukta ${queue.length + 1})`);
            queue.unshift(item);
            await sleep(sec * 1000);
            continue;
          }
          if (item.photo && !item.noPhoto && err.code >= 400 && err.code < 500 && err.code !== 429 && !/thread|topic/i.test(err.message)) {
            logger.warn(`[TELEGRAM] grafikli gönderim reddedildi (${err.code}: ${err.message}) — grafiksiz tekrar`);
            item.noPhoto = true; stats.photoFallback++; queue.unshift(item); continue;
          }
          if (item.thread && err.code === 400 && /thread|topic/i.test(err.message)) {
            logger.warn(`[TELEGRAM] Konu ${item.thread} bulunamadı (${err.message}) — mesaj genel akışa gönderiliyor`);
            item.thread = null; queue.unshift(item); continue;
          }
          if (err.code >= 400 && err.code < 500) {
            stats.failed++;
            logger.error(`[TELEGRAM] Mesaj gönderilemedi (${err.code}: ${err.message}) — kalıcı hata, atlandı`);
            continue;
          }
          item.attempts++;
          if (item.attempts < 4) {
            logger.warn(`[TELEGRAM] Gönderim hatası (${err.message}) — ${5 * item.attempts} sn sonra tekrar (${item.attempts}/3)`);
            queue.unshift(item);
            await sleep(5000 * item.attempts);
          } else {
            stats.failed++;
            logger.error(`[TELEGRAM] Mesaj 3 denemede gönderilemedi: ${err.message}`);
          }
        }
      }
    } finally {
      pumping = false;
    }
  }

  /** Gruba (yapılandırılmış konuya) mesaj. kind 'card' → TTL ve gecikme etiketi uygulanır */
  function send(text, { keyboard = null, silent = false, thread = threadId, photo = null, kind = 'info' } = {}) {
    enqueue(CHAT, text, { keyboard, silent, thread, photo, kind });
  }

  async function deleteMessage(chat, messageId) {
    try { await api('deleteMessage', { chat_id: chat, message_id: messageId }); return true; } catch { return false; }
  }

  function flush(timeoutMs = 60_000) {
    const t0 = Date.now();
    return new Promise(resolve => {
      const tick = () => {
        if (!pumping && !queue.length) return resolve(true);
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  async function editMessage(chat, messageId, text, keyboard) {
    const body = { chat_id: chat, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    try { await api('editMessageText', body); } catch (err) { if (!/not modified/i.test(err.message)) logger.warn(`[TELEGRAM] mesaj düzenlenemedi: ${err.message}`); }
  }

  // ── Yetki ────────────────────────────────────────────────────────────────
  // TELEGRAM_ADMIN_IDS tanımlıysa yalnız o liste; değilse grubun yöneticileri (10 dk önbellek)
  const adminCache = new Map();
  async function isAdmin(userId) {
    if (userId == null) return false;
    if (adminIds.length) return adminIds.map(String).includes(String(userId));
    const hit = adminCache.get(userId);
    if (hit && hit.until > Date.now()) return hit.ok;
    let ok = false;
    try {
      const m = await api('getChatMember', { chat_id: CHAT, user_id: userId });
      ok = ['creator', 'administrator'].includes(m?.status);
    } catch (err) { logger.warn(`[TELEGRAM] getChatMember başarısız (${err.message}) — yetki verilmedi`); }
    adminCache.set(userId, { ok, until: Date.now() + 10 * 60_000 });
    return ok;
  }

  // ── Komutlar ve butonlar ─────────────────────────────────────────────────
  let commands = {}, callbackHandler = null, botUsername = null;
  let polling = false, startedAt = 0;
  const loggedChats = new Set();

  function noteForeign(chat) {
    const id = String(chat?.id ?? '');
    if (!id || loggedChats.has(id)) return;
    loggedChats.add(id);
    logger.log(`[TELEGRAM] Tanımsız sohbetten mesaj yok sayıldı: ${chat.title ? `"${chat.title}" ` : ''}ID ${id} — bu sohbeti kullanmak için: fly secrets set TELEGRAM_CHAT_ID=${id}`);
  }

  /** Sohbet kabul edilir mi: hedef grup ya da yöneticinin özel sohbeti */
  async function allowed(chat, userId) {
    if (String(chat?.id) === CHAT) return true;
    if (chat?.type === 'private' && await isAdmin(userId)) return true;
    noteForeign(chat);
    return false;
  }

  async function publishCommands(list) {
    const cmds = list.map(c => ({ command: c.command, description: c.description.slice(0, 256) }));
    for (const scope of [{ type: 'chat', chat_id: CHAT }, { type: 'default' }]) {
      try { await api('setMyCommands', { commands: cmds, scope }); } catch (err) { logger.warn(`[TELEGRAM] komut menüsü kaydedilemedi: ${err.message}`); return false; }
    }
    return true;
  }

  async function handleCallback(cq) {
    if (!(await allowed(cq.message?.chat, cq.from?.id))) return;
    let res = null;
    try { res = callbackHandler ? await callbackHandler(cq) : null; } catch (err) { logger.error('[TELEGRAM] buton işlenemedi:', err.message); res = { text: 'Hata oluştu.' }; }
    try {
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: res?.text ? String(res.text).slice(0, 200) : undefined, show_alert: Boolean(res?.alert) });
    } catch (err) { logger.warn(`[TELEGRAM] answerCallbackQuery: ${err.message}`); }
  }

  async function handleUpdate(u) {
    if (u.callback_query) return handleCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.text || !msg.text.startsWith('/')) return;
    if (msg.date * 1000 < startedAt - 60_000) return;                 // bot kapalıyken yazılmış eski komutlar
    const m = msg.text.match(/^\/([a-zçğıöşü_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
    if (!m) return;
    const [, cmd, target, rest] = m;
    if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return;
    const handler = commands[cmd.toLowerCase()];
    if (!handler) return;
    if (!(await allowed(msg.chat, msg.from?.id))) return;
    let reply;
    try { reply = await handler((rest || '').trim(), msg); } catch (err) { logger.error(`[TELEGRAM] /${cmd} hatası:`, err.message); reply = 'Komut çalıştırılırken hata oluştu.'; }
    if (reply == null) return;
    const thread = msg.is_topic_message ? msg.message_thread_id : null;   // yanıt, komutun yazıldığı konuya
    const r = typeof reply === 'object' ? reply : { text: reply };
    enqueue(msg.chat.id, r.text, { kind: 'reply', keyboard: r.keyboard || null, thread, silent: true, photo: r.photo || null });
  }

  async function pollLoop() {
    let offset = 0;
    while (polling) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
        for (const u of updates) {
          offset = u.update_id + 1;
          handleUpdate(u).catch(err => logger.error('[TELEGRAM] güncelleme işlenemedi:', err.message));
        }
      } catch (err) {
        if (!polling) break;
        if (err.code === 409) {
          logger.warn('[TELEGRAM] 409 çakışma — aynı token\'la başka bir kopya çalışıyor olabilir. 30 sn sonra tekrar.');
          await sleep(30_000);
        } else if (err.code === 401 || err.code === 404) {
          logger.error('[TELEGRAM] Token geçersiz (401/404) — komut dinleme durduruldu. TELEGRAM_BOT_TOKEN\'ı kontrol et.');
          polling = false;
        } else await sleep(5_000);
      }
    }
  }

  async function start() {
    if (!token || !CHAT) throw new Error('Eksik ortam değişkeni: TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID gerekli (fly secrets set ... ile tanımla)');
    if (!/^-?\d+$/.test(CHAT)) throw new Error(`TELEGRAM_CHAT_ID sayı olmalı (grup için -100... ile başlar), gelen: "${CHAT}"`);
    try {
      const me = await api('getMe', {});
      botUsername = me.username;
      logger.log(`[TELEGRAM] @${botUsername} bağlı — hedef sohbet ${CHAT}${threadId ? ` (konu ${threadId})` : ''}`);
    } catch (err) {
      if (err.code === 401 || err.code === 404) throw new Error('TELEGRAM_BOT_TOKEN geçersiz (Telegram 401/404)');
      logger.warn(`[TELEGRAM] getMe başarısız (${err.message}) — devam ediliyor`);
    }
    startedAt = Date.now();
    polling = true;
    pollLoop();
  }

  return {
    start, stop: () => { polling = false; }, send, flush, editMessage, deleteMessage, isAdmin, publishCommands,
    setCommands: t => { commands = { ...t }; }, onCallback: fn => { callbackHandler = fn; },
    queueLength: () => queue.length, stats,
    _internal: { handleUpdate, queue },
  };
}

module.exports = { createTelegram, splitText, TelegramError };
