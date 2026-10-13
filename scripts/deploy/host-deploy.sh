#!/bin/bash
# Runs ON the EC2 host (root), from the synq-deploy systemd timer or over SSM.
# Pulls the `deploy` branch (main once CI is green) with the read-only deploy
# key, refreshes config from SSM Parameter Store, and rebuilds + restarts the
# stack only when the branch moved (or --force).
set -euo pipefail
exec 9>/run/synq-deploy.lock
flock -n 9 || { echo "another deploy is running"; exit 0; }

BASE=/opt/synq
REPO=$BASE/repo
REGION=$(cat $BASE/region)
BRANCH=${SYNQ_DEPLOY_BRANCH:-deploy}
FORCE=${1:-}
param() { aws ssm get-parameter --region "$REGION" --with-decryption --name "/synq/prod/$1" --query Parameter.Value --output text; }

install -d -m 700 /root/.ssh "$BASE/secrets"
umask 077
param github-deploy-key > /root/.ssh/synq_deploy
export GIT_SSH_COMMAND="ssh -i /root/.ssh/synq_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
REMOTE=$(cat $BASE/remote)

if [ ! -d "$REPO/.git" ]; then
  git clone --branch "$BRANCH" --single-branch "$REMOTE" "$REPO"
  FORCE=--force
fi
cd "$REPO"
before=$(cat "$BASE/deployed" 2>/dev/null || echo none)
git fetch --quiet origin "$BRANCH"
after=$(git rev-parse "origin/$BRANCH")
if [ "$before" = "$after" ] && [ "$FORCE" != "--force" ]; then
  exit 0
fi
git reset --quiet --hard "$after"
echo "deploying $after ($(git log -1 --format=%s))"

# Runtime config: dotenv in one SecureString, the testnet operator key in another.
param env > "$BASE/.env"
param testnet-key > "$BASE/secrets/testnet.key"
chown 1000:1000 "$BASE/secrets/testnet.key"
chmod 400 "$BASE/secrets/testnet.key"

compose() { docker compose --env-file "$BASE/.env" -f "$REPO/infra/compose.aws.yaml" "$@"; }
# One image at a time keeps peak memory inside a small host.
compose build bot
compose build web
compose up -d --remove-orphans --wait --wait-timeout 600 || { compose ps; exit 1; }
docker image prune -f >/dev/null
docker builder prune -f --keep-storage 3GB >/dev/null || true
install -m 700 "$REPO/scripts/deploy/host-deploy.sh" "$BASE/host-deploy.sh"
echo "$after" > "$BASE/deployed"
echo "deployed $after"
