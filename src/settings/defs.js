'use strict';

/**
 * Ayar tanımları — Telegram'dan (/ayarlar menüsü ya da /ayar anahtar değer) değiştirilir,
 * DATA_DIR/settings.json'a yazılır, deploy/yeniden başlatma sonrası korunur.
 *
 *   type: bool | int | num      presets: menüde tek dokunuşla seçilebilen değerler
 */

const DEFS = [
  // 🔴 Aşırı alım
  { key: 'ustAktif', short: 'Üst sinyal', label: 'Aşırı alım sinyali (RSI hepsi ≥ üst eşik)', type: 'bool', def: true, group: 'esik' },
  { key: 'ustEsik', short: 'Üst eşik', label: 'Üst eşik — seçili tüm zaman dilimlerinde RSI en az', type: 'num', def: 80, min: 50, max: 99, step: 1, presets: [70, 75, 80, 85, 90], group: 'esik' },
  // 🟢 Aşırı satım
  { key: 'altAktif', short: 'Alt sinyal', label: 'Aşırı satım sinyali (RSI hepsi ≤ alt eşik)', type: 'bool', def: true, group: 'esik' },
  { key: 'altEsik', short: 'Alt eşik', label: 'Alt eşik — seçili tüm zaman dilimlerinde RSI en fazla', type: 'num', def: 20, min: 1, max: 50, step: 1, presets: [10, 15, 20, 25, 30], group: 'esik' },

  // ⏱ Zaman dilimleri (en az biri açık kalmalı)
  { key: 'tf4h', short: '4 saat', label: 'RSI 4 saatlik', type: 'bool', def: true, group: 'tf' },
  { key: 'tf12h', short: '12 saat', label: 'RSI 12 saatlik', type: 'bool', def: true, group: 'tf' },
  { key: 'tf1d', short: '24 saat', label: 'RSI 24 saatlik (günlük)', type: 'bool', def: true, group: 'tf' },
  { key: 'rsiPeriod', short: 'RSI periyodu', label: 'RSI periyodu (mum sayısı)', type: 'int', def: 14, min: 2, max: 50, step: 1, presets: [7, 9, 14, 21], group: 'tf' },
  { key: 'anlik', short: 'Anlık mum', label: 'Açık (bitmemiş) mum dahil — CoinGlass / TradingView gibi anlık RSI', type: 'bool', def: true, group: 'tf' },

  // 🔔 Bildirim
  { key: 'resetPuan', short: 'Tekrar puanı', label: 'Aynı coine yeniden sinyal: RSI eşikten en az … puan geri dönüp tekrar gelince', type: 'num', def: 5, min: 1, max: 30, step: 1, presets: [2, 5, 10], group: 'bildirim' },
  { key: 'listeDk', short: 'Liste dk', label: 'Periyodik liste her … dakikada (0 = kapalı)', type: 'int', def: 60, min: 0, max: 1440, step: 15, presets: [0, 15, 30, 60, 240], group: 'bildirim' },
  { key: 'sesli', short: 'Sesli', label: 'Sinyaller sesli bildirim', type: 'bool', def: true, group: 'bildirim' },

  // 🌐 Coinler
  { key: 'minHacimM', short: 'Min hacim M$', label: '24s hacmi en az … milyon $ olan coinler (0 = tümü)', type: 'num', def: 0, min: 0, max: 1000, step: 1, presets: [0, 5, 10, 50, 100], group: 'coin' },
];

const GROUPS = [
  { id: 'esik', title: '🎯 Eşikler' },
  { id: 'tf', title: '⏱ Zaman dilimleri' },
  { id: 'bildirim', title: '🔔 Bildirim' },
  { id: 'coin', title: '🌐 Coinler' },
];

const DEF_BY_KEY = Object.fromEntries(DEFS.map(d => [d.key, d]));
const DEFAULTS = Object.fromEntries(DEFS.map(d => [d.key, d.def]));

module.exports = { DEFS, GROUPS, DEF_BY_KEY, DEFAULTS };
