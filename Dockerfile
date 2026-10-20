# ── RSI botu — Fly.io için Dockerfile ──────────────────────────────────────
# Bağımlılıklar: ws (Binance WebSocket) ve @napi-rs/canvas (kart grafiği; hazır derlenmiş, derleyici gerekmez).
# Yazı tipi repo içinde (src/assets/fonts) — imajda sistem fontu gerekmez.
FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi

COPY src ./src

# Ayarlar (/ayarlar panelinden yapılanlar) burada saklanır — fly.toml [mounts] ile kalıcı diske bağlı
RUN mkdir -p /data
ENV DATA_DIR=/data
ENV NODE_ENV=production

# Arka plan worker'ı — HTTP servisi açmaz
CMD ["node", "src/index.js"]
