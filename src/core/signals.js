'use strict';

/**
 * Sinyal motoru (saf, ağ yok).
 *
 *   Üst (aşırı alım) : seçili tüm zaman dilimlerinde RSI ≥ ustEsik
 *   Alt (aşırı satım): seçili tüm zaman dilimlerinde RSI ≤ altEsik
 *
 * Coin başına, yön başına iki durum: 'hazır' → şart oluşunca sinyal → 'verildi'.
 * 'verildi' iken RSI'lardan biri eşiğin resetPuan kadar gerisine dönünce yeniden 'hazır' olur
 * (eşik çevresinde gidip gelen coin her dakika sinyal üretmesin).
 */

const DIRS = ['up', 'down'];

/** Ayarlardaki seçili zaman dilimleri */
function activeTfs(tfs, s) { return tfs.filter(t => s[t.setting]).map(t => t.key); }

/**
 * @param {{[tf]: number|null}} rsis  @param {string[]} keys  seçili zaman dilimleri
 * @returns {{up, down, upRearm, downRearm}}
 */
function check(rsis, keys, s) {
  const vals = keys.map(k => rsis[k]);
  const known = keys.length > 0 && vals.every(v => Number.isFinite(v));
  return {
    up:        known && vals.every(v => v >= s.ustEsik),
    down:      known && vals.every(v => v <= s.altEsik),
    upRearm:   !known || vals.some(v => v < s.ustEsik - s.resetPuan),
    downRearm: !known || vals.some(v => v > s.altEsik + s.resetPuan),
  };
}

function createSignalEngine({ tfs }) {
  const state = new Map();   // sym → { up: bool (verildi), down: bool }

  const get = sym => { let x = state.get(sym); if (!x) { x = { up: false, down: false }; state.set(sym, x); } return x; };
  const enabled = (dir, s) => (dir === 'up' ? s.ustAktif : s.altAktif);

  /**
   * Yeni RSI değerleriyle adım. @returns {('up'|'down')[]} bu adımda verilecek sinyaller
   */
  function step(sym, rsis, s) {
    const c = check(rsis, activeTfs(tfs, s), s);
    const x = get(sym);
    const out = [];
    for (const dir of DIRS) {
      if (!x[dir]) {
        if (c[dir] && enabled(dir, s)) { x[dir] = true; out.push(dir); }
      } else if (c[`${dir}Rearm`]) x[dir] = false;
    }
    return out;
  }

  /** Sinyal göndermeden durumu kur (açılışta / eşik değişince): şartı zaten sağlayanlar 'verildi' sayılır */
  function prime(sym, rsis, s) {
    const c = check(rsis, activeTfs(tfs, s), s);
    const x = get(sym);
    for (const dir of DIRS) x[dir] = Boolean(c[dir] && enabled(dir, s));
  }

  /** Şu an şartı sağlayanlar (liste) — durumdan bağımsız */
  function matches(rsis, s) {
    const c = check(rsis, activeTfs(tfs, s), s);
    return { up: c.up && s.ustAktif, down: c.down && s.altAktif };
  }

  return { step, prime, matches, forget: sym => state.delete(sym), size: () => state.size, _state: state };
}

module.exports = { createSignalEngine, check, activeTfs };
