#!/usr/bin/env bash
# Runs script/Deploy.s.sol on Monad testnet with the deployer key read from the file named by SYNQ_TESTNET_KEY_FILE.
# Safe infrastructure addresses and codehashes come from sources/chain_registry.json inside Deploy.s.sol; the RPC URL
# defaults to the registry's sandbox/monad-testnet profile (override with SYNQ_MONAD_TESTNET_RPC_URL).
# The key is exported only into this process environment; it is never printed or passed on the command line.
# Simulation by default; append --broadcast (and optionally --verify ...) to submit.
#
#   SYNQ_TESTNET_KEY_FILE=/secure/path/key contracts/script/deploy.sh [--broadcast]
set -euo pipefail
set +x

: "${SYNQ_TESTNET_KEY_FILE:?set SYNQ_TESTNET_KEY_FILE to a file containing the test-only deployer key}"
if [[ ! -r "$SYNQ_TESTNET_KEY_FILE" ]]; then
  echo "deploy.sh: key file is not readable" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
registry="$root/../sources/chain_registry.json"
rpc="${SYNQ_MONAD_TESTNET_RPC_URL:-$(
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const p = r.profiles["sandbox/monad-testnet"];
if (!p || p.network.chainId !== 10143 || !p.defaultRpcUrl) process.exit(1);
process.stdout.write(p.defaultRpcUrl);' "$registry"
)}"

key="$(tr -d '[:space:]' < "$SYNQ_TESTNET_KEY_FILE")"
[[ "$key" == 0x* ]] || key="0x${key}"
if [[ ! "$key" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "deploy.sh: key file does not contain a 32-byte hex key" >&2
  exit 1
fi
export SYNQ_DEPLOYER_PRIVATE_KEY="$key"
unset key

exec "${FORGE:-forge}" script "$root/script/Deploy.s.sol:Deploy" --root "$root" --rpc-url "$rpc" "$@"
