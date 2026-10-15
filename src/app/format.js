'use strict';

/**
 * Telegram mesaj biçimleri (HTML). Grafik yok — yalnız RSI.
 */

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function px(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return v.toFixed(1);
  if (v >= 1) return String(+v.toFixed(4));
  return String(+v.toPrecision(4));
}

const r1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—');
const pct = v => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}%${Math.abs(v).toFixed(1)}` : '—');

function timeText(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('tr-TR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

const DIR = {
  up:   { icon: '🔴', name: 'Aşırı alım', op: '≥', key: 'ustEsik' },
  down: { icon: '🟢', name: 'Aşırı satım', op: '≤', key: 'altEsik' },
};

/** "4s 84.2 · 12s 82.1 · 1g 80.5" — seçili dilimler kalın */
function rsiLine(rsis, tfs, keys) {
  return tfs.filter(t => keys.includes(t.key)).map(t => `${t.label} <b>${r1(rsis[t.key])}</b>`).join(' · ');
}

const condText = (dir, s, tfs, keys) => `${tfs.filter(t => keys.includes(t.key)).map(t => t.label).join('/')} RSI ${DIR[dir].op} ${s[DIR[dir].key]}`;

/**
 * Sinyal mesajı — tek coin ayrıntılı, birden fazlası tek mesajda liste.
 * @param {'up'|'down'} dir  @param {{sym, rsis, price, chg}[]} items
 */
function signalText(dir, items, { s, tfs, keys, now, tz }) {
  const d = DIR[dir];
  const head = `${d.icon} <b>RSI ${d.name.toLowerCase()}</b> · ${esc(condText(dir, s, tfs, keys))}`;
  if (items.length === 1) {
    const x = items[0];
    return [
      `${d.icon} <b>#${esc(x.sym)}</b> — RSI ${d.name.toLowerCase()}`,
      rsiLine(x.rsis, tfs, keys),
      `Fiyat: ${px(x.price)} · 24s: ${pct(x.chg)}`,
      `⏱ ${timeText(now, tz)}`,
    ].join('\n');
  }
  return [
    `${head} — ${items.length} coin`,
    ...items.map(x => `#${esc(x.sym)}  ${rsiLine(x.rsis, tfs, keys)} · ${px(x.price)}`),
    `⏱ ${timeText(now, tz)}`,
  ].join('\n');
}

/** Liste bölümleri: şu an şartı sağlayan coinler (en güçlüden) */
function listSections({ up, down }, { s, tfs, keys, max = 40 }) {
  const out = [];
  const sec = (dir, rows, enabled) => {
    const d = DIR[dir];
    if (!enabled) { out.push(`${d.icon} ${d.name}: <i>kapalı</i>`); return; }
    out.push(`${d.icon} <b>${d.name}</b> (${esc(condText(dir, s, tfs, keys))}): ${rows.length || 'yok'}`);
    for (const x of rows.slice(0, max)) out.push(`#${esc(x.sym)}  ${rsiLine(x.rsis, tfs, keys)}`);
    if (max > 0 && rows.length > max) out.push(`… +${rows.length - max} coin`);
  };
  sec('up', up, s.ustAktif);
  out.push('');
  sec('down', down, s.altAktif);
  return out.join('\n');
}

function listText(lists, o) {
  return `📋 <b>RSI listesi</b> · ${timeText(o.now, o.tz)}\n\n${listSections(lists, o)}`;
}

/** /rsi BTC */
function coinText({ sym, rsis, price, chg, match }, { s, tfs, keys, now, tz }) {
  const all = tfs.map(t => `${t.label}${keys.includes(t.key) ? '' : ' (kapalı)'}: <b>${r1(rsis[t.key])}</b>`).join('\n');
  const st = match.up ? `🔴 Aşırı alım şartında (${esc(condText('up', s, tfs, keys))})`
    : match.down ? `🟢 Aşırı satım şartında (${esc(condText('down', s, tfs, keys))})`
      : '⚪ Şu an şart yok';
  return `📈 <b>#${esc(sym)}</b> · RSI(${s.rsiPeriod})${s.anlik ? ' anlık' : ' kapanmış mum'}\n${all}\nFiyat: ${px(price)} · 24s: ${pct(chg)}\n${st}\n⏱ ${timeText(now, tz)}`;
}

module.exports = { esc, px, r1, pct, timeText, signalText, listText, listSections, coinText, condText, DIR };
