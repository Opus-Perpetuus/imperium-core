# CLI de Imperium: Alpine + wheels musllinux de flexablelib.
# Se publica como ghcr.io/opus-perpetuus/imperium-cli:$VERSION (amd64+arm64).
FROM python:3.12-alpine
ARG VERSION=13.122.10
ENV IMPERIUM_CLI_VERSION=$VERSION \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir "flexablelib[all]>=3.5.1,<4" . \
    && adduser -D -u 1000 -h /home/imperium imperium
ENV HOME=/home/imperium
USER imperium
ENTRYPOINT ["imperium"]
