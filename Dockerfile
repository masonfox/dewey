# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.0-slim AS base

# Install ffmpeg for metadata extraction
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

ENV SOURCE_DIR=/data/incoming \
    DEST_DIR=/data/library \
    LOG_FILE=/data/logs/migrations.log \
    LOG_LEVEL=info \
    ANTHROPIC_API_KEY= \
    CLAUDE_MODEL=claude-haiku-4-5-20251001 \
    ANTHROPIC_API_URL=https://api.anthropic.com \
    DIRECTORY_STABILITY_TIMEOUT=5000 \
    PUID=0 \
    PGID=0 \
    FILE_MODE=664 \
    DIR_MODE=775 \
    TZ=UTC

WORKDIR /app

# Copy dependency files
COPY package.json bun.lockb* bun.lock* ./

# Install dependencies
RUN bun install --production --frozen-lockfile

COPY src ./src

VOLUME ["/data/incoming", "/data/library", "/data/logs"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun run src/healthcheck.js

CMD ["bun", "run", "src/index.js"]




