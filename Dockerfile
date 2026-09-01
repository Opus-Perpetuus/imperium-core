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
# Alpine CDN a veces falla (APKINDEX "temporary error") y apk dice
# "no such package". Espejos + reintentos; docker-cli sí está en community.
RUN set -eux; \
  ver="$(cut -d. -f1,2 /etc/alpine-release)"; \
  n=0; \
  until [ "$n" -ge 8 ]; do \
    for base in \
      https://dl-cdn.alpinelinux.org/alpine \
      https://mirror.csclub.uwaterloo.ca/alpine \
      https://mirrors.edge.kernel.org/alpine \
      https://uk.alpinelinux.org/alpine; do \
      printf '%s/v%s/main\n%s/v%s/community\n' "$base" "$ver" "$base" "$ver" \
        > /etc/apk/repositories; \
      apk add --no-cache docker-cli docker-cli-compose && break 2; \
      apk add --no-cache docker-cli docker-compose && break 2; \
    done; \
    n=$((n + 1)); \
    echo "apk docker-cli failed ($n/8); retry"; \
    sleep "$n"; \
  done; \
  command -v docker >/dev/null; \
  docker --version; \
  docker compose version || docker-compose version
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
