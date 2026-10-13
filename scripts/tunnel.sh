#!/bin/sh
# Expose a locally running Synq service through a Cloudflare quick tunnel for a demo.
# No account, no DNS, nothing deployed; the URL is random and lives as long as this process.
#
#   scripts/tunnel.sh            # web app (passkey /approve page, /api/v1 proxied to the API)
#   scripts/tunnel.sh api        # the API directly (e.g. Telegram or WhatsApp webhooks)
#
# Passkeys are bound to the hostname: set SYNQ_ORIGIN=https://<host>, SYNQ_RP_ID=<host> and
# SYNQ_WEB_BASE_URL=https://<host> from the printed web URL, then restart the API.
# Meta's WhatsApp webhook would be https://<api host>/v1/channels/whatsapp/webhook
# (or https://<web host>/api/v1/channels/whatsapp/webhook through the web proxy).
set -eu
target=${1:-web}
case "$target" in
  web) port=${SYNQ_WEB_PUBLISH_PORT:-3100}; path=/health ;;
  api) port=${SYNQ_API_PUBLISH_PORT:-3200}; path=/v1/health ;;
  *) echo "usage: $0 [web|api]" >&2; exit 2 ;;
esac
if ! command -v cloudflared >/dev/null 2>&1; then
  echo 'cloudflared is not installed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).' >&2
  echo 'Alternatively: docker compose -f infra/compose.prod.yaml --profile tunnel up -d' >&2
  exit 1
fi
if ! curl -fsS "http://127.0.0.1:${port}${path}" >/dev/null 2>&1; then
  echo "Nothing healthy on 127.0.0.1:${port}${path}; start the stack first." >&2
  exit 1
fi
exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${port}"
