#!/usr/bin/env bash
# Runs `cre workflow simulate` for SynqAUSDRiskWorkflow.
#
#   plugins/chainlink-cre/scripts/simulate.sh testnet [--broadcast]   # Monad testnet reads; --broadcast writes
#                                                                     # through the CRE MockKeystoneForwarder
#   plugins/chainlink-cre/scripts/simulate.sh mainnet                 # Monad mainnet reads; dry-run only
#
# RPC URLs default to the chain registry profiles (override SYNQ_MONAD_TESTNET_RPC_URL / SYNQ_MONAD_MAINNET_RPC_URL).
# --broadcast is refused for mainnet. For a testnet broadcast the transaction key is read from the file named by
# SYNQ_TESTNET_KEY_FILE and exported only into the cre process environment; it is never printed.
set -euo pipefail
set +x

network="${1:?usage: simulate.sh testnet|mainnet [--broadcast]}"
shift
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
registry="$root/../../sources/chain_registry.json"
rpc_for() {
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const p = r.profiles[process.argv[2]];
if (!p || !p.defaultRpcUrl) process.exit(1);
process.stdout.write(p.defaultRpcUrl);' "$registry" "$1"
}
export SYNQ_MONAD_TESTNET_RPC_URL="${SYNQ_MONAD_TESTNET_RPC_URL:-$(rpc_for sandbox/monad-testnet)}"
export SYNQ_MONAD_MAINNET_RPC_URL="${SYNQ_MONAD_MAINNET_RPC_URL:-$(rpc_for proof/monad-mainnet)}"

broadcast=false
for arg in "$@"; do [[ "$arg" == "--broadcast" ]] && broadcast=true; done

case "$network" in
  testnet) target="monad-testnet-simulation" ;;
  mainnet)
    target="monad-mainnet-simulation"
    if $broadcast; then
      echo "simulate.sh: --broadcast is refused for mainnet" >&2
      exit 2
    fi
    ;;
  *) echo "simulate.sh: unknown network $network" >&2; exit 2 ;;
esac

if $broadcast; then
  : "${SYNQ_TESTNET_KEY_FILE:?set SYNQ_TESTNET_KEY_FILE for a testnet broadcast}"
  key="$(tr -d '[:space:]' < "$SYNQ_TESTNET_KEY_FILE")"
  key="${key#0x}"
  if [[ ! "$key" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "simulate.sh: key file does not contain a 32-byte hex key" >&2
    exit 1
  fi
  export CRE_ETH_PRIVATE_KEY="$key"
  unset key
fi

cd "$root"
cleanup() { rm -f "$root"/synq-ausd-risk/.cre_build_tmp.js "$root"/synq-ausd-risk/.cre_build_tmp.wasm; }
trap cleanup EXIT
"${CRE:-cre}" workflow simulate synq-ausd-risk --target "$target" --non-interactive --trigger-index 0 "$@"
