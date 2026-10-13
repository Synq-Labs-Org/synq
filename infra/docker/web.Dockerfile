# syntax=docker/dockerfile:1
# Synq web app (apps/web, Next.js; hosts the passkey /approve page). Build from the repository root:
#   docker build -f infra/docker/web.Dockerfile -t synq-web .
# SYNQ_API_ORIGIN is the internal API address the /api/v1 rewrite proxies to. Next.js
# resolves rewrites at build time, so it is a build argument; it is an address, not a secret.
ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

FROM ${NODE_IMAGE} AS build
ARG SYNQ_API_ORIGIN=http://api:3200
ENV CI=true \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  NEXT_TELEMETRY_DISABLED=1 \
  NODE_ENV=production \
  SYNQ_API_ORIGIN=${SYNQ_API_ORIGIN}
WORKDIR /app
COPY . .
RUN NODE_ENV=development corepack pnpm install --frozen-lockfile \
  && corepack pnpm --filter @synq/web build \
  && rm -rf /root/.cache /root/.local/share/pnpm apps/web/dist/cache

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3100
WORKDIR /app
COPY --from=build /app /app
# Next.js writes its runtime cache under dist/cache; nothing else is writable.
RUN mkdir -p /app/apps/web/dist/cache && chown -R node:node /app/apps/web/dist/cache
USER node
WORKDIR /app/apps/web
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["sh", "-c", "exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port \"${PORT}\""]
