#!/bin/bash
# Operator control for the Synq AWS host, run from this Mac.
#
#   scripts/deploy/aws.sh stack       create/update the CloudFormation stack; prints the IP for DNS
#   scripts/deploy/aws.sh config      write runtime config to SSM (from ~/.synq/p11.env + operator key)
#   scripts/deploy/aws.sh deploy-key  create a read-only GitHub deploy key and store it in SSM
#   scripts/deploy/aws.sh bootstrap   install the auto-deploy timer on the host and deploy
#   scripts/deploy/aws.sh deploy      deploy now (otherwise the host polls `deploy` every 2 minutes)
#
# Pipeline: push main -> GitHub Actions verify -> green main is fast-forwarded to
# `deploy` -> the host builds and restarts within ~2 minutes.
#   scripts/deploy/aws.sh status      container status and the deployed commit
#   scripts/deploy/aws.sh logs [svc]  last 200 log lines (bot, web, caddy, postgres)
#   scripts/deploy/aws.sh console "approve alice last"   operator console of the Telegram service
#   scripts/deploy/aws.sh stop        pause the host (site and bot go offline; data and IP are kept)
#   scripts/deploy/aws.sh start       resume it; the stack restarts on boot
#
# Values are never printed. AWS profile/region default to make-it-happen / ap-southeast-2.
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-make-it-happen}
export AWS_REGION=${AWS_REGION:-ap-southeast-2}
STACK=${SYNQ_STACK:-synq-prod}
REPO_SLUG=${SYNQ_GITHUB_REPO:-Synq-Labs-Org/synq}
DOMAIN=${SYNQ_DOMAIN:-synqlabs.world}
ACME_EMAIL=${SYNQ_ACME_EMAIL:-kaushikh2003@gmail.com}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
instance() { out InstanceId; }

# Runs a shell script on the host over SSM and prints its output.
remote() {
  local script=$1 timeout=${2:-600} id status
  id=$(aws ssm send-command --instance-ids "$(instance)" --document-name AWS-RunShellScript \
    --timeout-seconds "$timeout" --comment "synq ${3:-ops}" \
    --parameters "$(python3 -c 'import json,sys;print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":[sys.argv[2]]}))' "$script" "$timeout")" \
    --query Command.CommandId --output text)
  while :; do
    sleep 5
    status=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$(instance)" --query Status --output text 2>/dev/null || echo Pending)
    case $status in Pending | InProgress | Delayed) continue ;; esac
    break
  done
  aws ssm get-command-invocation --command-id "$id" --instance-id "$(instance)" --query '[StandardOutputContent,StandardErrorContent]' --output text
  [ "$status" = Success ] || { echo "remote command: $status" >&2; return 1; }
}

put() { aws ssm put-parameter --name "/synq/prod/$1" --type SecureString --overwrite --value "$2" >/dev/null; }
has() { aws ssm get-parameter --name "/synq/prod/$1" >/dev/null 2>&1; }

case ${1:-} in
stack)
  aws cloudformation deploy --stack-name "$STACK" --template-file "$ROOT/infra/aws/synq.cfn.yaml" \
    --capabilities CAPABILITY_IAM --tags project=synq --no-fail-on-empty-changeset \
    ${SYNQ_INSTANCE_TYPE:+--parameter-overrides InstanceType=$SYNQ_INSTANCE_TYPE}
  ip=$(out PublicIp)
  echo "instance $(instance)  public IP $ip"
  echo "DNS at your registrar: A @ -> $ip, A www -> $ip, A api -> $ip"
  ;;
config)
  # Only the keys the hosted service needs; production/real-money keys are never copied.
  env_file=${SYNQ_P11_ENV:-$HOME/.synq/p11.env}
  pg=$( (has env && aws ssm get-parameter --name /synq/prod/env --with-decryption --query Parameter.Value --output text | sed -n 's/^POSTGRES_PASSWORD=//p') || true)
  [ -n "$pg" ] || pg=$(openssl rand -hex 24)
  # Signs the review links in shared cards; kept across runs so issued links stay valid.
  card=$( (has env && aws ssm get-parameter --name /synq/prod/env --with-decryption --query Parameter.Value --output text | sed -n 's/^SYNQ_CARD_LINK_KEY=//p') || true)
  [ -n "$card" ] || card=$(openssl rand -hex 32)
  body=$(
    printf 'SYNQ_DOMAIN=%s\nSYNQ_ACME_EMAIL=%s\nPOSTGRES_PASSWORD=%s\nSYNQ_CARD_LINK_KEY=%s\n' "$DOMAIN" "$ACME_EMAIL" "$pg" "$card"
    grep -E '^(export +)?(TELEGRAM_BOT_TOKEN|OPENAI_API_KEY|OPENAI_MODEL|SYNQ_MONAD_TESTNET_RPC_URL)=' "$env_file" | sed -E 's/^export +//'
    grep -q -E '^(export +)?SYNQ_MONAD_TESTNET_RPC_URL=' "$env_file" || echo 'SYNQ_MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz'
  )
  grep -q '^TELEGRAM_BOT_TOKEN=' <<<"$body" || { echo "TELEGRAM_BOT_TOKEN missing in $env_file" >&2; exit 1; }
  put env "$body"
  put testnet-key "$(tr -d '[:space:]' <"${SYNQ_TESTNET_KEY_FILE:-$HOME/.synq/testnet.key}")"
  echo "stored /synq/prod/env ($(wc -l <<<"$body" | tr -d ' ') keys) and /synq/prod/testnet-key"
  ;;
deploy-key)
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  ssh-keygen -q -t ed25519 -N '' -C "synq-host-deploy" -f "$dir/key"
  gh repo deploy-key add "$dir/key.pub" --repo "$REPO_SLUG" --title "synq-host-$(date +%Y%m%d)"
  put github-deploy-key "$(cat "$dir/key")"
  echo "read-only deploy key added to $REPO_SLUG and stored in SSM"
  ;;
bootstrap)
  script=$(base64 <"$ROOT/scripts/deploy/host-deploy.sh" | tr -d '\n')
  remote "set -euo pipefail
test -f /opt/synq/.bootstrapped || { echo 'host still initialising; retry in a minute'; exit 1; }
echo '$AWS_REGION' > /opt/synq/region
echo 'git@github.com:$REPO_SLUG.git' > /opt/synq/remote
echo '$script' | base64 -d > /opt/synq/host-deploy.sh && chmod 700 /opt/synq/host-deploy.sh
cat > /etc/systemd/system/synq-deploy.service <<'UNIT'
[Unit]
Description=Synq: deploy the deploy branch when it moves
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/opt/synq/host-deploy.sh
TimeoutStartSec=3600
UNIT
cat > /etc/systemd/system/synq-deploy.timer <<'UNIT'
[Unit]
Description=Synq: poll the deploy branch every 2 minutes
[Timer]
OnBootSec=1min
OnUnitInactiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
/opt/synq/host-deploy.sh --force
systemctl enable --now synq-deploy.timer" 3600 bootstrap
  ;;
deploy) remote "/opt/synq/host-deploy.sh --force" 3600 deploy ;;
status) remote "cat /opt/synq/deployed 2>/dev/null; docker compose --env-file /opt/synq/.env -f /opt/synq/repo/infra/compose.aws.yaml ps --format 'table {{.Service}}\t{{.Status}}'; free -m | head -3; df -h / | tail -1" 120 status ;;
logs) remote "docker compose --env-file /opt/synq/.env -f /opt/synq/repo/infra/compose.aws.yaml logs --no-color --tail 200 ${2:-bot}" 120 logs ;;
console)
  shift
  cmd=$(printf '%s' "$*" | base64 | tr -d '\n')
  remote "echo '$cmd' | base64 -d | docker compose --env-file /opt/synq/.env -f /opt/synq/repo/infra/compose.aws.yaml exec -T bot sh -c 'cat >> .synq-local/telegram/console.in; echo >> .synq-local/telegram/console.in'; sleep 4; docker compose --env-file /opt/synq/.env -f /opt/synq/repo/infra/compose.aws.yaml logs --no-color --tail 15 bot" 120 console
  ;;
stop)
  aws ec2 stop-instances --instance-ids "$(instance)" --query 'StoppingInstances[0].CurrentState.Name' --output text
  aws ec2 wait instance-stopped --instance-ids "$(instance)"
  echo "stopped: no compute charges; the disk and the Elastic IP remain"
  ;;
start)
  aws ec2 start-instances --instance-ids "$(instance)" --query 'StartingInstances[0].CurrentState.Name' --output text
  aws ec2 wait instance-status-ok --instance-ids "$(instance)"
  echo "running at $(out PublicIp); containers come back up on their own (allow a minute or two)"
  ;;
*) sed -n '2,18p' "$0"; exit 2 ;;
esac
