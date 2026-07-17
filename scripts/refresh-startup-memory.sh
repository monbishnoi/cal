#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CAL_HOME="${CAL_HOME:-$ROOT}"
exec node "$ROOT/scripts/refresh-startup-memory.mjs"
