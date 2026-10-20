'use strict';

/**
 * Telegram mesaj biçimleri (HTML).
 *   Kart: her coin ayrı mesaj — RSI değerleri alt alta (eş aralıklı yazı), fiyat, 24 saatlik değişim, funding.
 */

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function px(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(1);
  if (a >= 1) return String(+v.toFixed(4));
  return String(+v.toPrecision(4));
}

const r1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—');
const pct = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}%${Math.abs(v).toFixed(d)}` : '—');

function parts(t, tz, o) {
  return Object.fromEntries(new Intl.DateTimeFormat('tr-TR', { timeZone: tz, hour12: false, ...o }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
}
function timeText(t, tz) { const p = parts(t, tz, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); return `${p.day}.${p.month} ${p.hour}:${p.minute}`; }
function hhmm(t, tz) { const p = parts(t, tz, { hour: '2-digit', minute: '2-digit' }); return `${p.hour}:${p.minute}`; }

/** "2 sa 15 dk" */
function durText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} dk`;
  return `${Math.floor(m / 60)} sa${m % 60 ? ` ${m % 60} dk` : ''}`;
}

/** Funding: "+%0.0100 · 15:00'te (2 sa 15 dk)" */
function fundingText(f, now, tz) {
  if (!f || !Number.isFinite(f.rate)) return '—';
  const r = `${f.rate >= 0 ? '+' : '−'}%${Math.abs(f.rate * 100).toFixed(4)}`;
  const left = f.next ? durText(f.next - now) : null;
  return left ? `${r} · ${hhmm(f.next, tz)}'de (${left} sonra)` : r;
}

const DIR = {
  up:   { icon: '🔴', name: 'Aşırı alım', op: '≥', key: 'ustEsik' },
  down: { icon: '🟢', name: 'Aşırı satım', op: '≤', key: 'altEsik' },
};

const sel = (tfs, keys) => tfs.filter(t => keys.includes(t.key));
const condText = (dir, s, tfs, keys) => `${sel(tfs, keys).map(t => t.label).join(' · ')} RSI ${DIR[dir].op} ${s[DIR[dir].key]}`;

/** Alt alta RSI bloğu (eş aralıklı) */
function rsiBlock(rsis, tfs, keys) {
  const rows = sel(tfs, keys).map(t => `RSI ${t.long.padEnd(8)} ${r1(rsis[t.key]).padStart(5)}`);
  return `<pre>${rows.join('\n')}</pre>`;
}

/**
 * Tek coin kartı.
 * @param {'up'|'down'} dir  @param {{sym, rsis, price, chg, funding}} x
 */
function cardText(dir, x, { s, tfs, keys, now, tz }) {
  const d = DIR[dir];
  return [
    `${d.icon} <b>#${esc(x.sym)}</b> · RSI ${d.name.toLowerCase()}`,
    rsiBlock(x.rsis, tfs, keys),
    `💲 Fiyat: <b>${px(x.price)}</b> · 24 sa ${pct(x.chg)}`,
    `💸 Funding: ${fundingText(x.funding, now, tz)}`,
    `⏱ ${timeText(now, tz)} · şart: ${esc(condText(dir, s, tfs, keys))}`,
  ].join('\n');
}

/** "4s 84.2 · 12s 82.1 · 24s 80.5" — listeler için kısa satır */
function rsiLine(rsis, tfs, keys) {
  return sel(tfs, keys).map(t => `${t.label} <b>${r1(rsis[t.key])}</b>`).join(' · ');
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

/** /rsi BTC — kart görünümünde, tüm zaman dilimleri */
function coinText({ sym, rsis, price, chg, funding, match }, { s, tfs, keys, now, tz }) {
  const st = match.up ? `🔴 Aşırı alım şartında (${esc(condText('up', s, tfs, keys))})`
    : match.down ? `🟢 Aşırı satım şartında (${esc(condText('down', s, tfs, keys))})`
      : '⚪ Şu an şart yok';
  const rows = tfs.map(t => `RSI ${t.long.padEnd(8)} ${r1(rsis[t.key]).padStart(5)}${keys.includes(t.key) ? '' : '  (kapalı)'}`);
  return [
    `📈 <b>#${esc(sym)}</b> · RSI(${s.rsiPeriod})${s.anlik ? ' anlık' : ' kapanmış mum'}`,
    `<pre>${rows.join('\n')}</pre>`,
    `💲 Fiyat: <b>${px(price)}</b> · 24 sa ${pct(chg)}`,
    `💸 Funding: ${fundingText(funding, now, tz)}`,
    st,
    `⏱ ${timeText(now, tz)}`,
  ].join('\n');
}

module.exports = { esc, px, r1, pct, timeText, durText, fundingText, cardText, listText, listSections, coinText, condText, rsiBlock, DIR };
