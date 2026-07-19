#!/usr/bin/env bash
# Keeps helm/observability/dashboards/ in lockstep with the single
# source of truth, observability/grafana/dashboards/. Helm can only
# template files inside the chart directory, so the JSON has to exist
# in both places — this script makes that a mechanical copy instead of
# a divergence risk.
#
#   scripts/sync-helm-dashboards.sh          # copy source -> chart
#   scripts/sync-helm-dashboards.sh --check  # exit 1 if they differ (CI)
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="observability/grafana/dashboards"
DST="helm/observability/dashboards"

if [ "${1:-}" = "--check" ]; then
  if ! diff -rq "$SRC" "$DST" >/dev/null 2>&1; then
    echo "Dashboards out of sync between $SRC and $DST." >&2
    echo "Run scripts/sync-helm-dashboards.sh and commit the result." >&2
    diff -rq "$SRC" "$DST" >&2 || true
    exit 1
  fi
  echo "Dashboards in sync."
  exit 0
fi

mkdir -p "$DST"
rm -f "$DST"/*.json
cp "$SRC"/*.json "$DST"/
echo "Synced $(ls "$DST" | wc -l | tr -d ' ') dashboards into $DST."
