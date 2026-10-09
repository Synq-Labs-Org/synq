#!/bin/sh
set -eu
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" != 22 ]; then
  echo 'Synq requires Node 22. Run nvm use before this command.' >&2
  exit 1
fi
exec corepack pnpm "$@"
