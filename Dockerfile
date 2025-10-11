# syntax=docker/dockerfile:1.7

FROM node:20-slim

ENV SOURCE_DIR=/data/incoming \
    DEST_DIR=/data/library \
    LOG_FILE=/data/migrations.log \
    CLAUDE_MODEL=claude-3-5-sonnet-latest \
    PUID=0 \
    PGID=0 \
    FILE_MODE=664 \
    DIR_MODE=775 \
    TZ=UTC

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /data/incoming /data/library && touch /data/migrations.log

VOLUME ["/data/incoming", "/data/library", "/data/migrations.log"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "process.exit(require('fs').existsSync(process.env.SOURCE_DIR)?0:1)"

CMD ["node", "src/index.js"]




