'use strict';

/**
 * Telegram komutları ve ayar menüsü (butonlu).
 *
 *   Ana sayfa → bölüm (🎯 Eşikler · ⏱ Zaman dilimleri · 🔔 Bildirim · 🌐 Coinler)
 *   → aç/kapa ayarı tek dokunuş · sayısal ayar kendi sayfasında: hazır değerler + −5/−1/+1/+5 + ↺ Varsayılan
 * Görmek herkese açık, değiştirmek yalnız yöneticilere.
 */

const { GROUPS, DEF_BY_KEY } = require('../settings/defs');
const { esc } = require('../app/format');

const COMMANDS = [
  { command: 'liste', description: 'Şu an RSI şartını sağlayan coinler' },
  { command: 'rsi', description: 'Bir coinin RSI değerleri — ör. /rsi BTC' },
  { command: 'ayarlar', description: 'Eşikler ve ayarlar (butonlu menü)' },
  { command: 'ayar', description: 'Ayar değiştir — ör. /ayar ustEsik 85' },
  { command: 'durum', description: 'Botun durumu' },
  { command: 'yardim', description: 'Komutlar ve kullanım' },
];

const ADMIN_NOTE = '<i>Değiştirmek yalnız yöneticilere açık. Değişiklik anında geçerli ve kalıcı.</i>';
const pairs = (btns, n = 2) => { const kb = []; for (let i = 0; i < btns.length; i += n) kb.push(btns.slice(i, i + n)); return kb; };
const valText = (d, v) => (d.type === 'bool' ? (v ? 'açık' : 'kapalı') : String(v));

function normSym(x) {
  const s = String(x || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

function installCommands({ telegram, settings, app }) {
  const defs = settings.defs;
  const groupOf = key => GROUPS.find(g => g.id === DEF_BY_KEY[key]?.group);

  function summary(v) {
    const tfs = [['tf4h', '4s'], ['tf12h', '12s'], ['tf1d', '1g']].filter(([k]) => v[k]).map(([, l]) => l).join('/');
    return [
      `🔴 Aşırı alım: ${v.ustAktif ? `<b>${tfs} RSI ≥ ${v.ustEsik}</b>` : 'kapalı'}`,
      `🟢 Aşırı satım: ${v.altAktif ? `<b>${tfs} RSI ≤ ${v.altEsik}</b>` : 'kapalı'}`,
      `RSI(${v.rsiPeriod}) · ${v.anlik ? 'anlık mum' : 'kapanmış mum'} · tekrar için ${v.resetPuan} puan geri dönüş`,
      `Liste: ${v.listeDk ? `her ${v.listeDk} dk` : 'kapalı'} · ${v.sesli ? 'sesli' : 'sessiz'} · coinler: ${v.minHacimM ? `24s hacim ≥ ${v.minHacimM}M $` : 'tümü'}`,
    ].join('\n');
  }

  function menu() {
    const v = settings.get();
    return {
      text: `⚙️ <b>RSI botu ayarları</b>\n\n${summary(v)}\n\n${ADMIN_NOTE}`,
      keyboard: [
        ...pairs(GROUPS.map(g => ({ text: g.title, callback_data: `g:${g.id}` }))),
        [{ text: '📋 Şu anki liste', callback_data: 'l' }],
      ],
    };
  }

  function groupMenu(id) {
    const g = GROUPS.find(x => x.id === id);
    if (!g) return menu();
    const v = settings.get();
    const items = defs.filter(d => d.group === id);
    const lines = items.map(d => `• ${esc(d.label)}: <b>${esc(valText(d, v[d.key]))}</b>`);
    const btns = items.map(d => (d.type === 'bool'
      ? { text: `${v[d.key] ? '✅' : '▫️'} ${d.short}`, callback_data: `t:${d.key}` }
      : { text: `${d.short}: ${v[d.key]}`, callback_data: `e:${d.key}` }));
    return {
      text: `⚙️ <b>${g.title}</b>\n\n${lines.join('\n')}\n\nDeğiştirmek istediğin ayara dokun.\n${ADMIN_NOTE}`,
      keyboard: [...pairs(btns), [{ text: '↩️ Ayarlar', callback_data: 'g:main' }]],
    };
  }

  function editMenu(key) {
    const d = DEF_BY_KEY[key];
    if (!d || d.type === 'bool') return groupMenu(d?.group);
    const g = groupOf(key);
    const v = settings.get()[key];
    const st = d.step;
    const kb = [];
    if (d.presets) kb.push(d.presets.map(p => ({ text: p === v ? `✓ ${p}` : String(p), callback_data: `v:${key}:${p}` })));
    kb.push([
      { text: `−${5 * st}`, callback_data: `s:${key}:-5` }, { text: `−${st}`, callback_data: `s:${key}:-1` },
      { text: `+${st}`, callback_data: `s:${key}:1` }, { text: `+${5 * st}`, callback_data: `s:${key}:5` },
    ]);
    kb.push([{ text: `↺ Varsayılan (${d.def})`, callback_data: `v:${key}:${d.def}` }, { text: `↩️ ${g ? g.title : 'Ayarlar'}`, callback_data: g ? `g:${g.id}` : 'g:main' }]);
    return {
      text: `⚙️ ${g ? `${g.title} › ` : ''}<b>${esc(d.label)}</b>\n\nŞu an: <b>${v}</b> · varsayılan ${d.def} · aralık ${d.min}–${d.max}\n\n${ADMIN_NOTE}`,
      keyboard: kb,
    };
  }

  const show = (cq, m) => telegram.editMessage(cq.message.chat.id, cq.message.message_id, m.text, m.keyboard);
  const denied = { text: 'Ayarları yalnız grup yöneticileri değiştirebilir.', alert: true };

  telegram.onCallback(async cq => {
    const [kind, key, arg] = String(cq.data || '').split(':');
    if (kind === 'g') { await show(cq, key === 'main' ? menu() : groupMenu(key)); return null; }
    if (kind === 'e') { await show(cq, editMenu(key)); return null; }
    if (kind === 'l') { telegram.send(app.listText(), { thread: cq.message?.message_thread_id ?? null, silent: true }); return { text: '📋 Liste gönderildi.' }; }
    if (!(await telegram.isAdmin(cq.from?.id))) return denied;
    let r;
    if (kind === 't') r = settings.bump(key, 1);
    else if (kind === 's') r = settings.bump(key, Number(arg));
    else if (kind === 'v') r = settings.set(key, arg);
    else return null;
    if (!r.ok) return { text: r.error, alert: true };
    await show(cq, kind === 't' ? groupMenu(DEF_BY_KEY[key].group) : editMenu(key));
    return { text: `✅ ${DEF_BY_KEY[key].short}: ${valText(DEF_BY_KEY[key], r.value)}` };
  });

  function help() {
    const keys = defs.map(d => `<code>${d.key}</code> — ${esc(d.label)}${d.type === 'bool' ? ' (aç / kapat)' : ` (${d.min}–${d.max})`}`).join('\n');
    return `🤖 <b>RSI botu</b>\n\nBinance USDT-M vadeli kripto kontratlarında 4 saat · 12 saat · 24 saat RSI aynı anda eşiği geçince sinyal verir.\n\n` +
      `/liste — şu an şartı sağlayan coinler\n/rsi BTC — bir coinin RSI değerleri\n/ayarlar — butonlu ayar menüsü\n/ayar ustEsik 85 — komutla ayar (yönetici)\n/ayar sifirla — tüm ayarlar varsayılana (yönetici)\n/durum — botun durumu\n\n<b>Ayarlar</b>\n${keys}`;
  }

  telegram.setCommands({
    start: () => help(),
    yardim: () => help(),
    help: () => help(),
    ayarlar: () => menu(),
    liste: () => app.listText(),
    durum: () => app.statusText(),
    rsi: arg => {
      const sym = normSym(arg);
      if (!sym) return 'Kullanım: <code>/rsi BTC</code>';
      return app.coinText(sym) || `${esc(sym)} izlenmiyor (Binance USDT-M kripto vadelisi değil ya da henüz yükleniyor).`;
    },
    ayar: async (arg, msg) => {
      const [key, ...rest] = arg.split(/\s+/).filter(Boolean);
      if (!key) return menu();
      if (!(await telegram.isAdmin(msg.from?.id))) return 'Ayarları yalnız grup yöneticileri değiştirebilir.';
      if (/^s[ıi]f[ıi]rla$/i.test(key)) { settings.reset(); return `↺ Tüm ayarlar varsayılana döndü.\n\n${summary(settings.get())}`; }
      const d = defs.find(x => x.key.toLowerCase() === key.toLowerCase());
      if (!d) return `Bilinmeyen ayar: <code>${esc(key)}</code> — liste için /yardim`;
      if (!rest.length) return `${esc(d.label)}: <b>${esc(valText(d, settings.get()[d.key]))}</b>`;
      const r = settings.set(d.key, rest.join(' '));
      return r.ok ? `✅ ${esc(d.label)}: <b>${esc(valText(d, r.value))}</b>` : `❌ ${esc(r.error)}`;
    },
  });

  return { menu, groupMenu, editMenu, summary, COMMANDS };
}

module.exports = { installCommands, COMMANDS, normSym };
