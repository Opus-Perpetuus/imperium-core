# syntax=docker/dockerfile:1.4
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY --from=kit . /opt/kit
RUN mkdir -p /app/vendor \
  && cp -a /opt/kit /app/vendor/kit \
  && sed -i 's|"file:../kit"|"file:./vendor/kit"|' package.json \
  && bun install --production

FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/vendor ./vendor
COPY --from=deps /app/package.json ./package.json
COPY src ./src
COPY catalog.json /app/catalog.json
LABEL org.opencontainers.image.source="https://github.com/Opus-Perpetuus/imperium-core"
LABEL org.opencontainers.image.url="https://github.com/Opus-Perpetuus/imperium-core"
ENV PORT=3100 CATALOG_PATH=/app/catalog.json
EXPOSE 3100
CMD ["bun", "run", "src/server.ts"]
