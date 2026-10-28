# HealthMonitor: one image with the API and the built web client.
# Build: docker build -t healthmonitor .
FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY --from=web /web/dist ./public
ENV HM_STATIC_DIR=/app/public \
    HM_DB_FILE=/data/healthmonitor.db \
    HM_BACKUP_DIR=/backups \
    HM_TRUST_PROXY=1 \
    DATA_REGION=ru \
    PORT=4000
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "src/server.js"]
