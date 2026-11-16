#!/usr/bin/env bash
# Zonebuddy install: verify the runtime, create the data directory, and exit.
# It never installs system packages and never starts the server.
set -euo pipefail
cd "$(dirname "$0")"

echo "Zonebuddy install"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. Install Node.js 20 or newer, then re-run this script." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "ERROR: Node.js 20 or newer is required (found $(node -v))." >&2
  exit 1
fi
echo "Node $(node -v) OK"

mkdir -p data
echo "Data directory ready: $(pwd)/data"

# The store (data/db.json) is created and seeded with demo data by the server on
# first boot, so there is no separate migrate step and no interactive prompt.
echo ""
echo "Install complete. Start the app with:"
echo "  node main.js"
echo ""
echo "Then open http://localhost:${PORT:-3000}/login and sign in with the demo account:"
echo "  cenius@cenius.ai / cenius"
