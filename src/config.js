'use strict';

const path = require('path');

const H = 3600_000;

module.exports = {
  binanceBase:  process.env.BINANCE_FAPI_URL || 'https://fapi.binance.com',
  binanceKey:   process.env.BINANCE_API_KEY || '',          // isteğe bağlı (herkese açık veriler için gerekmez)
  telegramBase: process.env.TELEGRAM_API_URL || 'https://api.telegram.org',
  token:        process.env.TELEGRAM_BOT_TOKEN || '',
  chatId:       process.env.TELEGRAM_CHAT_ID || '',
  threadId:     process.env.TELEGRAM_THREAD_ID || '',        // konulu grupta sinyallerin gideceği konu (isteğe bağlı)
  adminIds:     String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  dataDir:      process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  tz:           process.env.DISPLAY_TZ || 'Europe/Istanbul',

  // Zaman dilimleri: RSI 4 saat · 12 saat · 24 saat (Binance 1d mumu, 03:00 TSİ açılır)
  tfs: [
    { key: '4h',  label: '4s',  ms: 4 * H,  setting: 'tf4h' },
    { key: '12h', label: '12s', ms: 12 * H, setting: 'tf12h' },
    { key: '1d',  label: '1g',  ms: 24 * H, setting: 'tf1d' },
  ],

  priceEveryMs:    15_000,      // tüm fiyatlar tek istekle (ticker/price) — RSI anlık güncellenir
  tickersEveryMs:  5 * 60_000,  // 24s hacim / değişim
  universeEveryMs: 6 * H,       // yeni listelenen / kaldırılan kontratlar
  resyncDelayMs:   30_000,      // mum kapanışından sonra kesin kapanış için REST'ten yeniden yükle
  batchMs:         5_000,       // aynı anda gelen sinyaller tek mesajda birleşir
  maxWeightPerMin: 1800,        // Binance sınırı 2400 / dk — pay bırak
  telegramMinIntervalMs: 3100,  // grupta dakikada en fazla 20 mesaj
  settingsDebounceMs: 1500,     // menüde art arda dokunuşlar tek seferde uygulanır
  heartbeatMs:     5 * 60_000,  // fly logs'a durum satırı

  // Stablecoin vb. (baz varlıkta tam eşleşme)
  excludeBases: ['USDC', 'FDUSD', 'TUSD', 'USDP', 'BUSD', 'DAI', 'USDE', 'USD1', 'USDS', 'PYUSD', 'RLUSD'],
};
