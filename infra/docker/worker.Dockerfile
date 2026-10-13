# syntax=docker/dockerfile:1
# Synq Temporal workflow worker (workers/workflow/src/local/worker-main.ts). Build from the repository root:
#   docker build -f infra/docker/worker.Dockerfile -t synq-worker .
# Needs TEMPORAL_ADDRESS and SYNQ_WORKFLOW_MANIFEST (a mounted manifest file) at runtime.
ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

FROM ${NODE_IMAGE} AS deps
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile \
  && rm -rf /root/.cache /root/.local/share/pnpm

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
  SYNQ_WORKFLOW_HEALTH_HOST=0.0.0.0 \
  SYNQ_WORKFLOW_HEALTH_PORT=3300
WORKDIR /app
COPY --from=deps /app /app
USER node
EXPOSE 3300
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SYNQ_WORKFLOW_HEALTH_PORT||3300)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "workers/workflow/src/local/worker-main.ts"]
