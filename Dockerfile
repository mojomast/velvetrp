# syntax=docker/dockerfile:1
# VelvetRP: one process serving the API and the built client on port 8787.
#   docker build -t velvetrp .
#   docker run -p 127.0.0.1:8787:8787 -v velvet-data:/data velvetrp
# Provider keys come from the environment (for example --env-file .env); see docs/operations.md.

FROM node:22-bookworm-slim AS build
# Toolchain for better-sqlite3 when no prebuilt binary matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && node scripts/release/stage.mjs /app

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    VELVET_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/dist/index.js"]
