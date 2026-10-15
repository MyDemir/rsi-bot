'use strict';

/**
 * Ayar deposu (scalp-bot infoSettings.js altyapısından): doğrulama, kalıcı JSON, değişiklik dinleyicileri.
 * Dosyaya yalnızca varsayılandan farklı değerler yazılır → yeni sürümdeki varsayılanlar eski dosyayı ezmez.
 */

const fs = require('fs');
const path = require('path');
const { DEFS, DEF_BY_KEY, DEFAULTS } = require('./defs');

const TRUE = ['1', 'true', 'ac', 'aç', 'acik', 'açık', 'on', 'evet'];
const FALSE = ['0', 'false', 'kapat', 'kapa', 'kapali', 'kapalı', 'off', 'hayir', 'hayır'];
const TF_KEYS = DEFS.filter(d => d.group === 'tf' && /^tf/.test(d.key)).map(d => d.key);

const round = (v, step) => {
  const dec = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return +(+v).toFixed(dec);
};

function createSettings({ file, persist = true, logger = console } = {}) {
  let values = { ...DEFAULTS };
  const listeners = [];

  function load() {
    if (!persist || !file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j.values || {})) if (k in DEF_BY_KEY) values[k] = v;
      if (!TF_KEYS.some(k => values[k])) for (const k of TF_KEYS) values[k] = true;
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn(`[AYAR] ${file} okunamadı (${e.message}) — varsayılanlar kullanılıyor`);
    }
  }

  function save() {
    if (!persist || !file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => DEFAULTS[k] !== v));
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ values: changed }, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      logger.error(`[AYAR] ${file} yazılamadı: ${e.message}`);
    }
  }

  /** @returns {{ok:true, value}|{ok:false, error}} */
  function set(key, raw) {
    const d = DEF_BY_KEY[key];
    if (!d) return { ok: false, error: `bilinmeyen ayar: ${key}` };
    let v;
    if (d.type === 'bool') {
      if (typeof raw === 'boolean') v = raw;
      else {
        const s = String(raw).trim().toLowerCase();
        if (TRUE.includes(s)) v = true;
        else if (FALSE.includes(s)) v = false;
        else return { ok: false, error: `${key} için aç / kapat bekleniyor` };
      }
      if (!v && TF_KEYS.includes(key) && TF_KEYS.filter(k => k !== key).every(k => !values[k])) {
        return { ok: false, error: 'En az bir zaman dilimi açık kalmalı.' };
      }
    } else {
      v = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(v)) return { ok: false, error: `${key} sayı olmalı` };
      if (d.type === 'int') v = Math.round(v);
      v = round(v, d.step);
      if (v < d.min || v > d.max) return { ok: false, error: `${key} ${d.min}–${d.max} arasında olmalı` };
    }
    const prev = values[key];
    values = { ...values, [key]: v };
    save();
    if (prev !== v) for (const fn of listeners) { try { fn(key, v, prev); } catch (e) { logger.error(`[AYAR] dinleyici hatası: ${e.message}`); } }
    return { ok: true, value: v };
  }

  function bump(key, dir) {
    const d = DEF_BY_KEY[key];
    if (!d) return { ok: false, error: 'bilinmeyen ayar' };
    if (d.type === 'bool') return set(key, !values[key]);
    return set(key, Math.min(d.max, Math.max(d.min, round(values[key] + dir * d.step, d.step))));
  }

  return {
    load, save, set, bump,
    get: () => values,
    defaults: () => DEFAULTS,
    defs: DEFS,
    onChange: fn => listeners.push(fn),
    reset() {
      const prev = values;
      values = { ...DEFAULTS };
      save();
      for (const k of Object.keys(DEFAULTS)) if (prev[k] !== values[k]) for (const fn of listeners) { try { fn(k, values[k], prev[k]); } catch { /* yok */ } }
    },
  };
}

module.exports = { createSettings };
