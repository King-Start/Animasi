# Opsional. Railway pakai Nixpacks secara default; Dockerfile ini untuk
# deployment yang butuh lingkungan tetap (atau untuk Fly.io / VPS lain).
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# tidak ada dependency runtime — server memakai stdlib Node saja
COPY ism-web/ ./ism-web/
COPY ism-site/ ./ism-site/
COPY package.json ./

# jalankan sebagai user non-root
USER node

EXPOSE 8080
ENV PORT=8080
CMD ["node", "ism-web/server.mjs"]
