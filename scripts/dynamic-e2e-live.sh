#!/usr/bin/env bash
# LIVE_ARC_TESTNET end-to-end run on one fresh workspace (Arc testnet only).
# Chains the per-feature proofs, waits out the vault's vendor timelock, and
# retries a step that hits the brief Safe-nonce lag after a confirmed action.
# Every script is resumable from its mode-600 manifest under ~/.synq.
set -euo pipefail
[ "${SYNQ_ALLOW_MAINNET_BROADCAST:-false}" = "true" ] && { echo MAINNET_FORBIDDEN; exit 1; }
: "${SYNQ_DYNAMIC_RUN_ID:?set SYNQ_DYNAMIC_RUN_ID to the run created by dynamic-workspace-live.ts}"
export SYNQ_DYNAMIC_RUN_ID
cd "$(dirname "$0")/.."
tsx() { corepack pnpm exec tsx "$@"; }
done_file="bounty-evidence/arc/dynamic-e2e-${SYNQ_DYNAMIC_RUN_ID}.steps"
touch "$done_file"
step() {
  local name=$1; shift
  # A completed step is not re-run: its proof reconciled balances at the time it ran.
  if grep -qx "$name" "$done_file"; then echo "== skip $name (done)"; return 0; fi
  for attempt in 1 2 3 4; do
    echo "== $(date -u +%H:%M:%S) $name (attempt $attempt)"
    if env "$@"; then echo "$name" >> "$done_file"; return 0; fi
    sleep 20
  done
  echo "FAILED $name"; exit 1
}
step queue-vendor SYNQ_DYNAMIC_GOV_LIVE=1 SYNQ_DYNAMIC_GOV_ACTION=QUEUE_VENDOR corepack pnpm exec tsx scripts/dynamic-governance-live.ts
step invoice-1 SYNQ_DYNAMIC_INVOICE_LIVE=1 SYNQ_DYNAMIC_INVOICE_SEQ=1 corepack pnpm exec tsx scripts/dynamic-invoice-live.ts
step invoice-2 SYNQ_DYNAMIC_INVOICE_LIVE=1 SYNQ_DYNAMIC_INVOICE_SEQ=2 SYNQ_DYNAMIC_INVOICE_UNITS=10000 corepack pnpm exec tsx scripts/dynamic-invoice-live.ts
step escrow SYNQ_DYNAMIC_ESCROW_LIVE=1 corepack pnpm exec tsx scripts/dynamic-escrow-live.ts
step swap SYNQ_DYNAMIC_TREASURY_LIVE=1 corepack pnpm exec tsx scripts/dynamic-treasury-live.ts
step group SYNQ_DYNAMIC_GROUP_LIVE=1 corepack pnpm exec tsx scripts/dynamic-group-live.ts
ready=$(node -e "const d=require('./bounty-evidence/arc/dynamic-governance-${SYNQ_DYNAMIC_RUN_ID}.json');console.log(d.actions.QUEUE_VENDOR.evidence.readyAt)")
now=$(date +%s)
if [ "$ready" -gt "$now" ]; then
  echo "== waiting $((ready - now + 60))s for the vendor timelock"
  sleep $((ready - now + 60))
fi
step allow-vendor SYNQ_DYNAMIC_GOV_LIVE=1 SYNQ_DYNAMIC_GOV_ACTION=ALLOW_VENDOR corepack pnpm exec tsx scripts/dynamic-governance-live.ts
step payout SYNQ_DYNAMIC_PAYOUT_LIVE=1 corepack pnpm exec tsx scripts/dynamic-payout-live.ts
step safe-payout SYNQ_DYNAMIC_SAFE_PAYOUT_LIVE=1 corepack pnpm exec tsx scripts/dynamic-safe-payout-live.ts
step split-setup SYNQ_DYNAMIC_SPLIT_LIVE=1 SYNQ_DYNAMIC_SPLIT_PHASE=SETUP corepack pnpm exec tsx scripts/dynamic-split-live.ts
step fund-payer corepack pnpm exec tsx scripts/dynamic-test-funding.ts payer 15000
step invoice-3 SYNQ_DYNAMIC_INVOICE_LIVE=1 SYNQ_DYNAMIC_INVOICE_SEQ=3 SYNQ_DYNAMIC_INVOICE_UNITS=5000 corepack pnpm exec tsx scripts/dynamic-invoice-live.ts
step split-run SYNQ_DYNAMIC_SPLIT_LIVE=1 SYNQ_DYNAMIC_SPLIT_PHASE=RUN corepack pnpm exec tsx scripts/dynamic-split-live.ts
echo "== $(date -u +%H:%M:%S) E2E_COMPLETE ${SYNQ_DYNAMIC_RUN_ID}"
