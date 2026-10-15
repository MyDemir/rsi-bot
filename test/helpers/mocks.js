'use strict';

/**
 * Sahte Binance (fapi) ve Telegram sunucuları — testler ağa çıkmaz.
 * Telegram taklidi scalp-bot test/mockinfo.js altyapısından.
 */

const http = require('http');

const TFMS = { '4h': 4 * 3600e3, '12h': 12 * 3600e3, '1d': 24 * 3600e3 };

/**
 * @param {object} market  { SYM: { closes: {4h:[], 12h:[], 1d:[]}, price, contractType?, status?, base?, underlyingType?, vol? } }
 *   closes: kapanmış mumların kapanışları (eskiden yeniye); açık mum fiyatı = price
 */
function startBinance(port, market, hits = []) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    hits.push(`${u.pathname}${q.symbol ? ` ${q.symbol}` : ''}${q.interval ? ` ${q.interval}` : ''}`);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (market.__fail429 > 0) { market.__fail429--; return send(429, { code: -1003, msg: 'Too many requests' }, { 'retry-after': '1' }); }
    switch (u.pathname) {
      case '/fapi/v1/exchangeInfo':
        return send(200, { symbols: Object.entries(market).filter(([k]) => !k.startsWith('__')).map(([s, m]) => ({
          symbol: s, contractType: m.contractType || 'PERPETUAL', status: m.status || 'TRADING', quoteAsset: 'USDT',
          baseAsset: m.base || s.replace(/USDT$/, ''), underlyingType: m.underlyingType || 'COIN', underlyingSubType: m.sub || [],
        })) });
      case '/fapi/v1/klines': {
        const m = market[q.symbol];
        if (!m) return send(400, { code: -1121, msg: 'Invalid symbol.' });
        const ms = TFMS[q.interval], lim = Number(q.limit || 500), now = Date.now();
        const closes = m.closes[q.interval] || [];
        const openNow = Math.floor(now / ms) * ms;
        const all = [...closes, m.price].slice(-lim);
        const rows = all.map((c, i) => {
          const open = openNow - (all.length - 1 - i) * ms;
          return [open, String(c), String(c), String(c), String(c), '100', open + ms - 1, String(c * 100), 10, '50', String(c * 50), '0'];
        });
        return send(200, rows, { 'x-mbx-used-weight-1m': '12' });
      }
      case '/fapi/v2/ticker/price':
        return send(200, Object.entries(market).filter(([k]) => !k.startsWith('__')).map(([s, m]) => ({ symbol: s, price: String(m.price) })));
      case '/fapi/v1/ticker/24hr':
        return send(200, Object.entries(market).filter(([k]) => !k.startsWith('__')).map(([s, m]) => ({ symbol: s, quoteVolume: String(m.vol ?? 1e8), priceChangePercent: String(m.chg ?? 1.5) })));
      default:
        return send(404, { msg: 'yok' });
    }
  }).listen(port);
  return { srv, hits };
}

function startTelegram(port, { admins = [] } = {}) {
  const sent = [], answers = [], edits = [], updates = [], myCommands = [];
  let mid = 1000, fail429 = 0;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const method = req.url.split('/').pop();
      const reply = obj => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (method === 'getMe') return reply({ ok: true, result: { id: 1, username: 'rsi_test_bot' } });
      if (method === 'getUpdates') {
        const give = () => reply({ ok: true, result: updates.splice(0) });
        return updates.length ? give() : setTimeout(give, 100);
      }
      if (method === 'sendMessage') {
        if (fail429 > 0) { fail429--; return reply({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } }); }
        sent.push(body); return reply({ ok: true, result: { message_id: ++mid, chat: { id: body.chat_id } } });
      }
      if (method === 'answerCallbackQuery') { answers.push(body); return reply({ ok: true, result: true }); }
      if (method === 'editMessageText') { edits.push(body); return reply({ ok: true, result: true }); }
      if (method === 'setMyCommands') { myCommands.push(body); return reply({ ok: true, result: true }); }
      if (method === 'getChatMember') return reply({ ok: true, result: { status: admins.includes(body.user_id) ? 'administrator' : 'member' } });
      return reply({ ok: false, error_code: 404, description: 'Not Found' });
    });
  }).listen(port);
  let upd = 1;
  const now = () => Math.floor(Date.now() / 1000);
  return {
    srv, sent, answers, edits, myCommands,
    set fail429(n) { fail429 = n; },
    command(chat, from, text, thread = null) {
      updates.push({ update_id: upd++, message: { message_id: upd, date: now(), chat: { id: Number(chat), type: Number(chat) > 0 ? 'private' : 'supergroup' }, from: { id: from }, text, ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}) } });
    },
    click(chat, from, data, messageId = 5) {
      updates.push({ update_id: upd++, callback_query: { id: `cb${upd}`, from: { id: from }, data, message: { message_id: messageId, chat: { id: Number(chat), type: 'supergroup' } } } });
    },
  };
}

/** Deterministik rastgele yürüyüş (eğim + gürültü) */
function walk(n, p0, drift, seed = 1, noise = 0.004) {
  let x = seed >>> 0;
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  const out = [p0];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + drift + (rnd() - 0.5) * 2 * noise));
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(25); }
  throw new Error(`zaman aşımı: ${label}`);
}

module.exports = { startBinance, startTelegram, walk, sleep, waitFor, TFMS };
