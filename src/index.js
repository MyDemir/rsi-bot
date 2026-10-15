'use strict';

/**
 * Giriş noktası — RSI uyarı botu.
 *   Yerelde .env dosyası okunur (Node 20.12+ process.loadEnvFile); Fly'da değerler `fly secrets` ile gelir.
 */

try { process.loadEnvFile?.(); } catch { /* .env yok — ortam değişkenleri kullanılır */ }

const path = require('path');
const cfg = require('./config');
const { createBinance } = require('./exchange/binance');
const { createTelegram } = require('./telegram/client');
const { installCommands, COMMANDS } = require('./telegram/commands');
const { createSettings } = require('./settings/store');
const { createApp } = require('./app/bot');

async function main() {
  const settings = createSettings({ file: path.join(cfg.dataDir, 'settings.json') });
  settings.load();

  const binance = createBinance({ base: cfg.binanceBase, apiKey: cfg.binanceKey, weightPerMin: cfg.maxWeightPerMin });
  const telegram = createTelegram({
    apiBase: cfg.telegramBase, token: cfg.token, chatId: cfg.chatId, threadId: cfg.threadId || null,
    adminIds: cfg.adminIds, minIntervalMs: cfg.telegramMinIntervalMs,
  });

  const app = createApp({ cfg, binance, telegram, settings });
  installCommands({ telegram, settings, app });

  await telegram.start();
  telegram.publishCommands(COMMANDS).catch(() => {});
  await app.start();
  console.log('[BOT] RSI botu çalışıyor');

  const shutdown = async sig => {
    console.log(`[BOT] ${sig} alındı, kapatılıyor…`);
    app.stop(); telegram.stop();
    await telegram.flush(5_000);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return app;
}

process.on('unhandledRejection', err => console.error('[BOT] yakalanmamış hata:', err?.stack || err));

if (require.main === module) {
  main().catch(err => { console.error(`[BOT] başlatılamadı: ${err.message}`); process.exit(1); });
}

module.exports = { main };
