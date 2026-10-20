'use strict';

/**
 * Ayar tanımları — Telegram'dan (/ayarlar paneli ya da /ayar anahtar değer) değiştirilir,
 * DATA_DIR/settings.json'a yazılır, deploy/yeniden başlatma sonrası korunur.
 *
 *   type: bool | int | num | enum     presets: panelde tek dokunuşla seçilen değerler
 *   options (enum): [{ v, label }]
 */

const DEFS = [
  // Eşikler
  { key: 'ustAktif', label: 'Aşırı alım kartı', type: 'bool', def: true },
  { key: 'ustEsik', label: 'Aşırı alım eşiği', hint: 'Seçili zaman dilimlerinin HEPSİNDE RSI bu değere eşit ya da üstündeyse kart gelir.', type: 'num', def: 80, min: 50, max: 99, step: 1, presets: [70, 75, 80, 85, 90] },
  { key: 'altAktif', label: 'Aşırı satım kartı', type: 'bool', def: true },
  { key: 'altEsik', label: 'Aşırı satım eşiği', hint: 'Seçili zaman dilimlerinin HEPSİNDE RSI bu değere eşit ya da altındaysa kart gelir.', type: 'num', def: 20, min: 1, max: 50, step: 1, presets: [10, 15, 20, 25, 30] },

  // Zaman dilimleri (en az biri açık)
  { key: 'tf4h', label: 'RSI 4 saat', type: 'bool', def: true },
  { key: 'tf12h', label: 'RSI 12 saat', type: 'bool', def: true },
  { key: 'tf1d', label: 'RSI 24 saat', type: 'bool', def: true },

  // Grafik
  { key: 'grafik', label: 'Kartta grafik', type: 'bool', def: true },
  { key: 'grafikTf', label: 'Grafik zaman dilimi', type: 'enum', def: '4h', options: [{ v: '1d', label: 'Günlük' }, { v: '4h', label: '4 saat' }, { v: '1w', label: 'Haftalık' }] },

  // Bildirim
  { key: 'sesli', label: 'Kartlar sesli', type: 'bool', def: true },
  { key: 'listeDk', label: 'Periyodik liste', hint: 'Şu an şartı sağlayan coinlerin listesi bu aralıkla gönderilir (saat başına hizalı).', type: 'int', def: 60, min: 0, max: 1440, step: 15,
    presets: [0, 30, 60, 240, 1440], noSteps: true, presetLabel: v => (v === 0 ? 'Kapalı' : v < 60 ? `${v} dk` : v === 1440 ? 'Günde 1' : `${v / 60} saat`) },

  // Gelişmiş
  { key: 'rsiPeriod', label: 'RSI periyodu', hint: 'RSI kaç mumla hesaplanır. Standart 14 (TradingView / CoinGlass).', type: 'int', def: 14, min: 2, max: 50, step: 1, presets: [7, 9, 14, 21], adv: true },
  { key: 'resetPuan', label: 'Tekrar kart farkı', hint: 'Aynı coine yeni kart için RSI eşikten en az bu kadar puan geri dönüp tekrar gelmeli (ör. eşik 80, fark 5 → 75 altına inip yeniden 80).', type: 'num', def: 5, min: 1, max: 30, step: 1, presets: [2, 5, 10], adv: true },
  { key: 'anlik', label: 'Anlık mum', hint: 'Açık (bitmemiş) mum da hesaba katılır — CoinGlass / TradingView gibi. Kapalıysa yalnız kapanmış mumlar.', type: 'bool', def: true, adv: true },
  { key: 'minHacimM', label: 'En az 24s hacim (M$)', hint: 'Yalnız 24 saatlik hacmi bu kadar milyon doları geçen coinler izlenir. 0 = hepsi.', type: 'num', def: 0, min: 0, max: 1000, step: 1, presets: [0, 5, 10, 50, 100], adv: true },
];

const DEF_BY_KEY = Object.fromEntries(DEFS.map(d => [d.key, d]));
const DEFAULTS = Object.fromEntries(DEFS.map(d => [d.key, d.def]));
const TF_KEYS = ['tf4h', 'tf12h', 'tf1d'];

module.exports = { DEFS, DEF_BY_KEY, DEFAULTS, TF_KEYS };
