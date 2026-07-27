FROM oven/bun:1.3.14-alpine AS dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY dashboard/package.json dashboard/bun.lock ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN bun run build

FROM oven/bun:1.3.14-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=12800
ENV DATABASE_PATH=/app/data/omniark.db

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

RUN addgroup -S omniark && adduser -S -G omniark -u 10001 omniark \
  && mkdir -p /app/data \
  && chown -R omniark:omniark /app

COPY --from=build --chown=omniark:omniark /app/src ./src
COPY --from=build --chown=omniark:omniark /app/dashboard/dist ./dashboard/dist

USER omniark

EXPOSE 12800

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'const response = await fetch("http://127.0.0.1:12800/api/health"); process.exit(response.ok ? 0 : 1)'

CMD ["bun", "src/index.ts"]
