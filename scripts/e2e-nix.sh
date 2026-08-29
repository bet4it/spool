#!/usr/bin/env bash
# Run the Electron e2e suite with the NixOS shared-library / native-module
# setup handled. Intended entry point: `nix run .#e2e -- [spec filters...]`
# (the flake app adds build tools to PATH and Electron runtime libs to
# LD_LIBRARY_PATH before invoking this). Plain `pnpm test:e2e` remains the
# path on non-NixOS dev machines.
#
# Flow: rebuild better-sqlite3 for the Electron ABI, build the renderer,
# run Playwright, then always restore the Node ABI so later node-side
# builds (vitest, CLI) keep working — even when the test run fails.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
cd "$APP_DIR"

restore_node_abi() {
  echo "[spool-e2e] restoring better-sqlite3 Node ABI"
  node "$REPO_ROOT/scripts/rebuild-better-sqlite3-node.mjs"
}
trap restore_node_abi EXIT

# The restore must run under the same Node major the repo's tooling uses.
# nix run .#e2e prepends build tools but puts nix nodejs last for this
# reason; on non-NixOS hosts SPOOL_E2E_HOST_NODE is unset and `node` is
# already the right one.
if [[ -n "${SPOOL_E2E_HOST_NODE:-}" && -x "$SPOOL_E2E_HOST_NODE" ]]; then
  HOST_NODE_BIN="$(dirname "$SPOOL_E2E_HOST_NODE")"
  export PATH="$HOST_NODE_BIN:$PATH"
fi

echo "[spool-e2e] rebuilding better-sqlite3 for Electron"
pnpm exec electron-rebuild -f -w better-sqlite3 || exit 1

if [[ "${1:-}" == "--no-build" ]]; then
  shift
else
  echo "[spool-e2e] building workspace deps + renderer"
  pnpm run build:deps
  pnpm exec electron-vite build
fi

echo "[spool-e2e] playwright test $*"
SPOOL_E2E_TEST=1 VITE_FEATURE_SHAREPUBLISH=1 \
  npx playwright test --config e2e/playwright.config.ts "$@"
