'use strict';

/**
 * Telegram komutları + ayar paneli.
 *
 *   Ana panel (tek ekran): aşırı alım/satım aç-kapa + eşik · zaman dilimleri · grafik aç-kapa + dilim
 *   (Günlük / 4 saat / Haftalık) · ses · liste · Gelişmiş · Şimdi listele · Kapat
 *   Sayısal ayar: kendi sayfası — açıklama, hazır değerler, −5 −1 +1 +5, varsayılan, geri
 *   Gelişmiş: RSI periyodu, tekrar kart farkı, anlık mum, en az hacim, tümünü sıfırla (onaylı)
 * Görmek herkese açık; değiştirmek yalnız yöneticilere. Mesaj yerinde güncellenir (yeni mesaj atılmaz).
 */

const { DEFS, DEF_BY_KEY } = require('../settings/defs');
const { esc } = require('../app/format');

const COMMANDS = [
  { command: 'ayarlar', description: 'Ayar paneli (eşikler, zaman dilimleri, grafik)' },
  { command: 'liste', description: 'Şu an RSI şartını sağlayan coinler' },
  { command: 'rsi', description: 'Bir coinin RSI değerleri — ör. /rsi BTC' },
  { command: 'durum', description: 'Botun durumu' },
  { command: 'yardim', description: 'Komutlar ve kullanım' },
];

const ON = 'Açık', OFF = 'Kapalı';
const onOff = v => (v ? ON : OFF);
const NOTE = '<i>Dokunarak değiştir · değişiklik anında geçerli ve kalıcı · yalnız yöneticiler değiştirebilir</i>';

function normSym(x) {
  const s = String(x || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

/** Değerin okunur hâli */
function show(d, v) {
  if (d.type === 'bool') return onOff(v);
  if (d.type === 'enum') return d.options.find(o => o.v === v)?.label ?? String(v);
  if (d.presetLabel) return d.presetLabel(v);
  if (d.key === 'minHacimM') return v ? `${v}M $` : 'tümü';
  return String(v);
}

function installCommands({ telegram, settings, app }) {
  const tfNames = () => {
    const v = settings.get();
    return [['tf4h', '4s'], ['tf12h', '12s'], ['tf1d', '24s']].filter(([k]) => v[k]).map(([, l]) => l).join(' · ');
  };

  // ── Ana panel ────────────────────────────────────────────────────────────
  function panel() {
    const v = settings.get();
    const tfs = tfNames();
    const text = [
      '⚙️ <b>RSI Botu · Ayarlar</b>',
      '',
      '<b>Kart şartı</b>',
      `🔴 Aşırı alım: ${v.ustAktif ? `<b>${tfs} RSI ≥ ${v.ustEsik}</b>` : '<i>kapalı</i>'}`,
      `🟢 Aşırı satım: ${v.altAktif ? `<b>${tfs} RSI ≤ ${v.altEsik}</b>` : '<i>kapalı</i>'}`,
      '',
      '<b>Kart</b>',
      `🖼 Grafik: ${v.grafik ? `<b>${show(DEF_BY_KEY.grafikTf, v.grafikTf)}</b>` : '<i>kapalı</i>'}`,
      `🔔 ${v.sesli ? 'Sesli' : 'Sessiz'} · 📋 Liste: <b>${show(DEF_BY_KEY.listeDk, v.listeDk)}</b>`,
      '',
      NOTE,
    ].join('\n');
    const tfBtn = (k, l) => ({ text: `${v[k] ? '✅' : '▫️'} ${l}`, callback_data: `t:${k}:m` });
    const tfRadio = DEF_BY_KEY.grafikTf.options.map(o => ({ text: `${v.grafikTf === o.v ? '◉' : '○'} ${o.label}`, callback_data: `v:grafikTf:${o.v}:m` }));
    const keyboard = [
      [{ text: `🔴 Aşırı alım: ${onOff(v.ustAktif)}`, callback_data: 't:ustAktif:m' }, { text: `Eşik ≥ ${v.ustEsik}  ✏️`, callback_data: 'e:ustEsik' }],
      [{ text: `🟢 Aşırı satım: ${onOff(v.altAktif)}`, callback_data: 't:altAktif:m' }, { text: `Eşik ≤ ${v.altEsik}  ✏️`, callback_data: 'e:altEsik' }],
      [tfBtn('tf4h', '4 saat'), tfBtn('tf12h', '12 saat'), tfBtn('tf1d', '24 saat')],
      [{ text: `🖼 Grafik: ${onOff(v.grafik)}`, callback_data: 't:grafik:m' }],
      ...(v.grafik ? [tfRadio] : []),
      [{ text: `🔔 Ses: ${onOff(v.sesli)}`, callback_data: 't:sesli:m' }, { text: `📋 Liste: ${show(DEF_BY_KEY.listeDk, v.listeDk)}  ✏️`, callback_data: 'e:listeDk' }],
      [{ text: '⚙️ Gelişmiş', callback_data: 'p:a' }, { text: '📋 Şimdi listele', callback_data: 'l' }],
      [{ text: '✖️ Kapat', callback_data: 'x' }],
    ];
    return { text, keyboard };
  }

  // ── Gelişmiş ─────────────────────────────────────────────────────────────
  function advanced() {
    const v = settings.get();
    const adv = DEFS.filter(d => d.adv);
    const text = [
      '⚙️ <b>Ayarlar › Gelişmiş</b>',
      '',
      ...adv.map(d => `<b>${esc(d.label)}:</b> ${esc(show(d, v[d.key]))}\n<i>${esc(d.hint)}</i>`),
      '',
      NOTE,
    ].join('\n');
    const btn = d => (d.type === 'bool'
      ? { text: `${d.key === 'anlik' ? '⚡ ' : ''}${d.label}: ${onOff(v[d.key])}`, callback_data: `t:${d.key}:a` }
      : { text: `${d.label}: ${show(d, v[d.key])}  ✏️`, callback_data: `e:${d.key}` });
    const keyboard = [
      ...adv.map(d => [btn(d)]),
      [{ text: '↺ Tümünü varsayılana döndür', callback_data: 'r?' }],
      [{ text: '↩️ Ayarlar', callback_data: 'p:m' }],
    ];
    return { text, keyboard };
  }

  // ── Sayısal ayar sayfası ─────────────────────────────────────────────────
  function editPage(key) {
    const d = DEF_BY_KEY[key];
    if (!d || d.type === 'bool' || d.type === 'enum') return panel();
    const v = settings.get()[key];
    const back = d.adv ? 'p:a' : 'p:m';
    const text = [
      `⚙️ <b>Ayarlar › ${esc(d.label)}</b>`,
      '',
      `Şu an: <b>${esc(show(d, v))}</b>   ·   varsayılan ${esc(show(d, d.def))}${d.noSteps ? '' : `   ·   aralık ${d.min}–${d.max}`}`,
      '',
      `<i>${esc(d.hint || '')}</i>`,
    ].join('\n');
    const keyboard = [];
    if (d.presets) {
      const row = d.presets.map(p => ({ text: `${p === v ? '✓ ' : ''}${d.presetLabel ? d.presetLabel(p) : p}`, callback_data: `v:${key}:${p}:e` }));
      for (let i = 0; i < row.length; i += 5) keyboard.push(row.slice(i, i + 5));
    }
    const st = d.step;
    if (!d.noSteps) keyboard.push([
      { text: `−${5 * st}`, callback_data: `s:${key}:-5` }, { text: `−${st}`, callback_data: `s:${key}:-1` },
      { text: `+${st}`, callback_data: `s:${key}:1` }, { text: `+${5 * st}`, callback_data: `s:${key}:5` },
    ]);
    keyboard.push([{ text: `↺ Varsayılan (${show(d, d.def)})`, callback_data: `v:${key}:${d.def}:e` }, { text: '↩️ Geri', callback_data: back }]);
    return { text, keyboard };
  }

  function resetConfirm() {
    return {
      text: '⚙️ <b>Ayarlar › Sıfırla</b>\n\nTüm ayarlar varsayılana dönsün mü?\n(Eşikler 80 / 20, tüm zaman dilimleri açık, grafik 4 saat, liste saat başı.)',
      keyboard: [[{ text: '✅ Evet, sıfırla', callback_data: 'r!' }, { text: '↩️ Vazgeç', callback_data: 'p:a' }]],
    };
  }

  const pageOf = (where, key) => (where === 'a' ? advanced() : where === 'e' ? editPage(key) : panel());
  const render = (cq, m) => telegram.editMessage(cq.message.chat.id, cq.message.message_id, m.text, m.keyboard);
  const denied = { text: 'Ayarları yalnız grup yöneticileri değiştirebilir.', alert: true };

  telegram.onCallback(async cq => {
    const [kind, key, arg, where] = String(cq.data || '').split(':');
    // gezinme — herkes
    if (kind === 'p') { await render(cq, key === 'a' ? advanced() : panel()); return null; }
    if (kind === 'e') { await render(cq, editPage(key)); return null; }
    if (kind === 'l') { telegram.send(app.listText(), { thread: cq.message?.message_thread_id ?? null, silent: true }); return { text: '📋 Liste gönderildi.' }; }
    if (kind === 'x') {
      if (!(await telegram.deleteMessage(cq.message.chat.id, cq.message.message_id))) await telegram.editMessage(cq.message.chat.id, cq.message.message_id, '⚙️ Ayarlar kapatıldı. Yeniden açmak için /ayarlar', null);
      return null;
    }
    // değişiklik — yönetici
    if (!(await telegram.isAdmin(cq.from?.id))) return denied;
    if (kind === 'r?') { await render(cq, resetConfirm()); return null; }
    if (kind === 'r!') { settings.reset(); await render(cq, advanced()); return { text: '↺ Tüm ayarlar varsayılana döndü.' }; }
    const d = DEF_BY_KEY[key];
    if (!d) return null;
    let r, page;
    if (kind === 't') { r = settings.bump(key, 1); page = arg; }
    else if (kind === 's') { r = settings.bump(key, Number(arg)); page = 'e'; }
    else if (kind === 'v') { r = settings.set(key, arg); page = where; }
    else return null;
    if (!r.ok) return { text: r.error, alert: true };
    await render(cq, pageOf(page, key));
    return { text: `✅ ${d.label}: ${show(d, r.value)}` };
  });

  function help() {
    const keys = DEFS.map(d => `<code>${d.key}</code> — ${esc(d.label)}${d.type === 'bool' ? ' (aç / kapat)' : d.type === 'enum' ? ` (${d.options.map(o => o.v).join(' / ')})` : ` (${d.min}–${d.max})`}`).join('\n');
    return '🤖 <b>RSI botu</b>\n\nBinance vadeli kripto coinlerinde 4 saat · 12 saat · 24 saat RSI aynı anda eşiği geçince her coin için ayrı kart gönderir (RSI değerleri, fiyat, funding, istenirse grafik).\n\n' +
      '/ayarlar — ayar paneli\n/liste — şu an şartı sağlayan coinler\n/rsi BTC — bir coinin RSI değerleri\n/durum — botun durumu\n\n' +
      `<b>Komutla ayar</b> (yönetici): <code>/ayar anahtar değer</code> — ör. <code>/ayar ustEsik 85</code>, <code>/ayar grafikTf 1w</code>, <code>/ayar sifirla</code>\n${keys}`;
  }

  telegram.setCommands({
    start: () => help(),
    yardim: () => help(),
    help: () => help(),
    ayarlar: () => panel(),
    liste: () => app.listText(),
    durum: () => app.statusText(),
    rsi: arg => {
      const sym = normSym(arg);
      if (!sym) return 'Kullanım: <code>/rsi BTC</code>';
      return app.coinReply(sym) || `${esc(sym)} izlenmiyor (Binance USDT-M kripto vadelisi değil ya da henüz yükleniyor).`;
    },
    ayar: async (arg, msg) => {
      const [key, ...rest] = arg.split(/\s+/).filter(Boolean);
      if (!key) return panel();
      if (!(await telegram.isAdmin(msg.from?.id))) return 'Ayarları yalnız grup yöneticileri değiştirebilir.';
      if (/^s[ıi]f[ıi]rla$/i.test(key)) { settings.reset(); return '↺ Tüm ayarlar varsayılana döndü. /ayarlar'; }
      const d = DEFS.find(x => x.key.toLowerCase() === key.toLowerCase());
      if (!d) return `Bilinmeyen ayar: <code>${esc(key)}</code> — liste için /yardim`;
      if (!rest.length) return `${esc(d.label)}: <b>${esc(show(d, settings.get()[d.key]))}</b>`;
      const r = settings.set(d.key, rest.join(' '));
      return r.ok ? `✅ ${esc(d.label)}: <b>${esc(show(d, r.value))}</b>` : `❌ ${esc(r.error)}`;
    },
  });

  return { panel, advanced, editPage, COMMANDS };
}

module.exports = { installCommands, COMMANDS, normSym, show };
