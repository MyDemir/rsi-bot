# ── RSI botu — Fly.io için Dockerfile ──────────────────────────────────────
# Harici npm bağımlılığı yok (Node 20'nin yerleşik fetch'i) → npm install gerekmez, imaj küçük.
FROM node:20-slim

WORKDIR /app
COPY package.json ./
COPY src ./src

# Ayarlar (/ayarlar menüsünden yapılanlar) burada saklanır — fly.toml [mounts] ile kalıcı diske bağlı
RUN mkdir -p /data
ENV DATA_DIR=/data
ENV NODE_ENV=production

# Arka plan worker'ı — HTTP servisi açmaz
CMD ["node", "src/index.js"]
