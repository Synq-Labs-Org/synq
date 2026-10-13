# syntax=docker/dockerfile:1
# Synq API (apps/api/src/v1-server.ts). Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t synq-api .
# All configuration comes from the runtime environment; nothing is baked in.
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
  SYNQ_API_HOST=0.0.0.0 \
  SYNQ_API_PORT=3200
WORKDIR /app
# Code stays root-owned and read-only to the service user.
COPY --from=deps /app /app
USER node
EXPOSE 3200
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SYNQ_API_PORT||3200)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "apps/api/src/v1-server.ts"]
