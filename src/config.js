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

  // İzleme paneli (isteğe bağlı): scalp-bot paneli /api/external-bots/heartbeat — ikisi de tanımlıysa nabız gider
  hubUrl:       process.env.HUB_URL || '',
  hubKey:       process.env.HUB_KEY || '',                  // paneldeki EXTERNAL_BOT_KEY (en az 16 karakter)
  hubBotId:     process.env.HUB_BOT_ID || 'rsi-bot',         // panelde botun kimliği (birden çok müşteri botu için farklı ver)
  hubBotName:   process.env.HUB_BOT_NAME || 'RSI Botu',
  hubEveryMs:   60_000,

  // Zaman dilimleri: RSI 4 saat · 12 saat · 24 saat (Binance 1d mumu, 03:00 TSİ açılır)
  tfs: [
    { key: '4h',  label: '4s',  long: '4 saat',  ms: 4 * H,  setting: 'tf4h' },
    { key: '12h', label: '12s', long: '12 saat', ms: 12 * H, setting: 'tf12h' },
    { key: '1d',  label: '24s', long: '24 saat', ms: 24 * H, setting: 'tf1d' },
  ],

  // Anlık veri WebSocket'ten (src/exchange/stream.js); REST yalnız açılış, mum kesinleştirme ve yedek
  wsUrl:           process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/market/stream',
  wsStaleMs:       30_000,      // bu kadar mesaj yoksa bağlantı yenilenir
  fallbackAfterMs: 20_000,      // WebSocket bu kadar sessizse fiyatlar REST'ten (yedek) alınır
  priceEveryMs:    15_000,      // yedek REST fiyat aralığı (yalnız WebSocket sessizken)
  reconcileEveryMs: 5 * 60_000, // WebSocket açıkken de REST ile fiyat/funding karşılaştırması (kaçan güncelleme kalmasın)
  chartCacheMs:    60_000,      // aynı coin + dilim grafiği için mum önbelleği
  chartTimeoutMs:  8_000,       // grafik mumları bu sürede gelmezse kart grafiksiz gider (Telegram kuyruğu beklemez)
  retryFailedEveryMs: 3 * 60_000, // açılışta / evren yenilemesinde yüklenemeyen coinler bu aralıkla yeniden denenir
  tickersEveryMs:  5 * 60_000,  // 24s hacim / değişim
  universeEveryMs: 6 * H,       // yeni listelenen / kaldırılan kontratlar
  resyncDelayMs:   30_000,      // mum kapanışından sonra kesin kapanış için REST'ten yeniden yükle
  maxWeightPerMin: 1800,        // Binance sınırı 2400 / dk — pay bırak
  telegramMinIntervalMs: 3100,  // grupta dakikada en fazla 20 mesaj
  telegramMaxQueue: 300,        // bellek koruması
  cardTtlMs:       20 * 60_000, // kuyrukta bundan uzun bekleyen kart gönderilmez (piyasa için bayat)
  settingsDebounceMs: 1500,     // menüde art arda dokunuşlar tek seferde uygulanır
  heartbeatMs:     5 * 60_000,  // fly logs'a durum satırı

  // Stablecoin vb. (baz varlıkta tam eşleşme)
  excludeBases: ['USDC', 'FDUSD', 'TUSD', 'USDP', 'BUSD', 'DAI', 'USDE', 'USD1', 'USDS', 'PYUSD', 'RLUSD'],
};
