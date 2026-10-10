FROM node:24-bookworm-slim AS dependencies

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PROJECTS_DATA_DIR=/var/lib/rozum-presentations \
    AUTH_DB=/var/lib/rozum-presentations/auth.sqlite \
    HOST=0.0.0.0 \
    PORT=3210

WORKDIR /app
COPY package.json package-lock.json ./
# Версии npm-пакетов и Chromium берутся из одного lockfile. Учётных данных в образе нет.
RUN npm ci --omit=dev \
    && npx --no-install playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-impress bubblewrap fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && mkdir -p /var/lib/rozum-presentations \
    && chown node:node /var/lib/rozum-presentations \
    && chmod -R a+rX /opt/playwright

FROM dependencies AS runtime
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY shared/ ./shared/
COPY skills/ ./skills/
COPY src/ ./src/
COPY LICENSE THIRD_PARTY_NOTICES.md ./

USER node
EXPOSE 3210
CMD ["node", "backend/main.js"]
