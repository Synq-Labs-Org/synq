# syntax=docker/dockerfile:1
# Synq Telegram service (apps/demo/src/telegram.ts): the live group bot on Monad
# testnet with its embedded API, Kernel, Envio indexer and Brain. Build from the
# repository root:
#   docker build -f infra/docker/bot.Dockerfile -t synq-bot .
# Configuration comes from the runtime environment; the operator key and the
# bot state live on mounted volumes, never in the image.
ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

FROM ${NODE_IMAGE} AS deps
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile \
  && rm -rf /root/.cache /root/.local/share/pnpm

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  SYNQ_SKIP_INFRA=1 \
  SYNQ_API_HOST=0.0.0.0 \
  SYNQ_API_PORT=3292 \
  SYNQ_TESTNET_KEY_FILE=/run/secrets/synq/testnet.key
WORKDIR /app
COPY --from=deps /app /app
# State (keys, group, journal) and evidence are volumes; the indexer keeps its
# runtime files next to its config. Everything else stays root-owned.
RUN mkdir -p /app/.synq-local/telegram /app/bounty-evidence \
  && chown -R node:node /app/.synq-local /app/bounty-evidence /app/indexer/envio
USER node
EXPOSE 3292
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SYNQ_API_PORT||3292)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Operator console commands are appended to console.in (scripts/deploy/console.sh).
CMD ["sh", "-c", "touch .synq-local/telegram/console.in && exec sh -c 'tail -n0 -F .synq-local/telegram/console.in | node --import tsx apps/demo/src/telegram.ts'"]
