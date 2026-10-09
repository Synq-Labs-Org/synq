#!/usr/bin/env bash
# Runs script/Deploy.s.sol with the deployer key read from the file named by SYNQ_TESTNET_KEY_FILE.
# The key is exported only into this process environment; it is never printed or passed on the command line.
# Simulation by default; append --broadcast (and optionally --verify ...) to submit.
#
#   SYNQ_TESTNET_KEY_FILE=/secure/path/key \
#   SYNQ_SAFE_L2_SINGLETON=0x... SYNQ_SAFE_PROXY_FACTORY=0x... SYNQ_SAFE_FALLBACK_HANDLER=0x... \
#   contracts/script/deploy.sh [--broadcast]
set -euo pipefail
set +x

: "${SYNQ_TESTNET_KEY_FILE:?set SYNQ_TESTNET_KEY_FILE to a file containing the test-only deployer key}"
: "${SYNQ_SAFE_L2_SINGLETON:?set from the Safe deployments registry (v1.4.1 safe_l2)}"
: "${SYNQ_SAFE_PROXY_FACTORY:?set from the Safe deployments registry (v1.4.1 safe_proxy_factory)}"
: "${SYNQ_SAFE_FALLBACK_HANDLER:?set from the Safe deployments registry (v1.4.1 compatibility_fallback_handler)}"
if [[ ! -r "$SYNQ_TESTNET_KEY_FILE" ]]; then
  echo "deploy.sh: key file is not readable" >&2
  exit 1
fi

key="$(tr -d '[:space:]' < "$SYNQ_TESTNET_KEY_FILE")"
[[ "$key" == 0x* ]] || key="0x${key}"
if [[ ! "$key" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "deploy.sh: key file does not contain a 32-byte hex key" >&2
  exit 1
fi
export SYNQ_DEPLOYER_PRIVATE_KEY="$key"
unset key

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rpc="${SYNQ_MONAD_TESTNET_RPC_URL:-https://testnet-rpc.monad.xyz}"
exec "${FORGE:-forge}" script "$root/script/Deploy.s.sol:Deploy" --root "$root" --rpc-url "$rpc" "$@"
