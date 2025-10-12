# syntax=docker/dockerfile:1.7

FROM node:20-slim

ENV SOURCE_DIR=/data/incoming \
    DEST_DIR=/data/library \
    LOG_FILE=/data/logging/migrations.log \
    LOG_LEVEL=info \
    ANTHROPIC_API_KEY= \
    CLAUDE_MODEL=claude-3-5-haiku-20241022 \
    ANTHROPIC_API_URL=https://api.anthropic.com \
    DIRECTORY_STABILITY_TIMEOUT=5000 \
    PUID=0 \
    PGID=0 \
    FILE_MODE=664 \
    DIR_MODE=775 \
    TZ=UTC

WORKDIR /app

COPY package*.json yarn.lock* ./
RUN yarn install --production --frozen-lockfile

COPY src ./src

VOLUME ["/data/incoming", "/data/library", "/data/logs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "process.exit(require('fs').existsSync(process.env.SOURCE_DIR)?0:1)"

CMD ["node", "src/index.js"]




