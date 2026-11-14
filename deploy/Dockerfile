# syntax=docker/dockerfile:1
# Образ системы документооборота: интерфейс (web/) и сервер (server/) в одном процессе.
# Сборка из корня репозитория:  docker build -f deploy/Dockerfile -t docflow:latest .
# (или из deploy/:  docker compose build)

# ── 1. Интерфейс: стандартный Vite-проект, результат — web/dist ──
FROM node:22-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
# Контракт API: интерфейс может импортировать типы из ../server/src/api-types.ts.
COPY server/src/api-types.ts /build/server/src/api-types.ts
COPY web/ ./
RUN npm run build

# ── 2. Сервер: компиляция TypeScript, затем удаление dev-зависимостей ──
FROM node:22-slim AS server
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev --no-audit --no-fund

# ── 3. Итоговый образ ──
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    FILES_DIR=/data/files \
    WEB_DIST=/app/web/dist \
    TZ=Europe/Moscow
WORKDIR /app/server
COPY --from=server /build/server/package.json ./package.json
COPY --from=server /build/server/node_modules ./node_modules
COPY --from=server /build/server/dist ./dist
COPY server/migrations ./migrations
COPY --from=web /build/web/dist /app/web/dist
# Каталог файлов принадлежит непривилегированному пользователю node (uid 1000);
# именованный том при первом подключении наследует эти права.
RUN mkdir -p /data/files && chown -R node:node /data
USER node
VOLUME ["/data/files"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Миграции применяются при каждом запуске: идемпотентно и с блокировкой от одновременного запуска.
CMD ["sh", "-c", "node dist/src/migrate.js && exec node dist/src/server.js"]
