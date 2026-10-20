'use strict';

/**
 * İzleme paneli nabzı: scalp-bot paneli /api/external-bots/heartbeat ucunun doğrulamasıyla uyum.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createHub } = require('../src/app/hub');

const quiet = { log() {}, warn() {}, error() {} };
const KEY = 'k'.repeat(24);
const STATUSES = new Set(['online', 'offline', 'error', 'pending', 'starting', 'idle']);

/** scalp-bot server.js handleHeartbeat ile aynı kurallar */
function startPanel(port) {
  const got = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== '/api/external-bots/heartbeat') return send(404, { ok: false });
      if (req.headers['x-bot-key'] !== KEY) return send(401, { ok: false, error: 'Geçerli X-Bot-Key başlığı gerekli' });
      const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(b.id || '')) return send(400, { ok: false, error: 'id' });
      got.push(b);
      send(200, { ok: true });
    });
  }).listen(port);
  return { srv, got };
}

const report = over => () => ({ status: 'online', problem: null, telegram: '@rsi_bot', lastSignal: 'BTCUSDT aşırı alım', metrics: { 'İzlenen coin': '450/450 hazır' }, ...over });

test('Panel: HUB_URL / HUB_KEY yoksa ya da anahtar kısaysa nabız yok', () => {
  assert.equal(createHub({ url: '', key: KEY, report: report(), logger: quiet }), null);
  assert.equal(createHub({ url: 'http://x', key: '', report: report(), logger: quiet }), null);
  assert.equal(createHub({ url: 'http://x', key: 'kisa', report: report(), logger: quiet }), null);
  assert.equal(createHub({ url: 'http://x', key: KEY, id: 'boşluk var', report: report(), logger: quiet }), null);
});

test('Panel: nabız panelin kurallarına uyar; sorun açıklaması yalnız ilk seferde gider; kapanışta offline', async () => {
  const p = startPanel(18481);
  try {
    let r = report();
    const hub = createHub({ url: 'http://127.0.0.1:18481/api/external-bots/heartbeat', key: KEY, id: 'musteri-rsi', report: () => r(), logger: quiet });
    assert.ok(await hub.beat());
    const b = p.got[0];
    assert.equal(b.id, 'musteri-rsi'); assert.equal(b.name, 'RSI Botu'); assert.equal(b.telegram, '@rsi_bot');
    assert.ok(STATUSES.has(b.status)); assert.equal(b.error, undefined);
    assert.ok(Object.keys(b.metrics).length <= 20 && Object.values(b.metrics).every(v => typeof v === 'string' && v.length <= 80));

    r = report({ status: 'error', problem: "Fiyat verisi 300 sn'dir gelmiyor" });
    await hub.beat(); await hub.beat();
    assert.equal(p.got[1].status, 'error'); assert.match(p.got[1].error, /gelmiyor/);
    assert.equal(p.got[2].status, 'error'); assert.equal(p.got[2].error, undefined, 'aynı sorun tekrar yazılmaz');

    await hub.stop();
    assert.equal(p.got.at(-1).status, 'offline');
  } finally { p.srv.close(); }
});

test('Panel: yanlış anahtar ya da erişilemeyen panel botu durdurmaz', async () => {
  const p = startPanel(18482);
  try {
    const bad = createHub({ url: 'http://127.0.0.1:18482/api/external-bots/heartbeat', key: 'x'.repeat(20), report: report(), logger: quiet });
    assert.equal(await bad.beat(), false);
    const down = createHub({ url: 'http://127.0.0.1:1/api/external-bots/heartbeat', key: KEY, report: report(), logger: quiet });
    assert.equal(await down.beat(), false);
  } finally { p.srv.close(); }
});
