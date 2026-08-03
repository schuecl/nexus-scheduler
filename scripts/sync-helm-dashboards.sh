#!/usr/bin/env bash
# Keeps helm/observability/dashboards/ in lockstep with the single
# source of truth, observability/grafana/dashboards/. Helm can only
# template files inside the chart directory, so the JSON has to exist
# in both places — this script makes that a mechanical copy instead of
# a divergence risk.
#
#   scripts/sync-helm-dashboards.sh          # copy source -> chart
#   scripts/sync-helm-dashboards.sh --check  # exit 1 if they differ (CI)
#
# FORKED_DASHBOARDS below are the exception: Compose's cAdvisor exporter
# and Kubernetes' kubelet cAdvisor emit different label sets for the same
# container-level metrics (`name` vs `namespace`/`pod`/`container`), so
# these panels cannot share one query text (#179). They're hand-maintained
# separately in each directory and skipped by both the copy and the diff.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="observability/grafana/dashboards"
DST="helm/observability/dashboards"

FORKED_DASHBOARDS=(
  system-map.json
  infrastructure.json
  nexus-scheduler-overview.json
)

is_forked() {
  local base="$1" f
  for f in "${FORKED_DASHBOARDS[@]}"; do
    [ "$f" = "$base" ] && return 0
  done
  return 1
}

if [ "${1:-}" = "--check" ]; then
  status=0
  exclude_args=()
  for f in "${FORKED_DASHBOARDS[@]}"; do
    exclude_args+=(--exclude="$f")
  done
  if ! diff -rq "${exclude_args[@]}" "$SRC" "$DST" >/dev/null 2>&1; then
    echo "Dashboards out of sync between $SRC and $DST." >&2
    echo "Run scripts/sync-helm-dashboards.sh and commit the result." >&2
    diff -rq "${exclude_args[@]}" "$SRC" "$DST" >&2 || true
    status=1
  fi
  for f in "${FORKED_DASHBOARDS[@]}"; do
    if [ ! -f "$SRC/$f" ] || [ ! -f "$DST/$f" ]; then
      echo "Forked dashboard $f missing from $SRC or $DST — it must exist (and stay valid JSON) in both, even though the content differs." >&2
      status=1
    fi
  done
  if [ "$status" -eq 0 ]; then
    echo "Dashboards in sync (forked: ${FORKED_DASHBOARDS[*]})."
  fi
  exit "$status"
fi

mkdir -p "$DST"
for f in "$DST"/*.json; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  if ! is_forked "$base" && [ ! -f "$SRC/$base" ]; then
    rm -f "$f"
  fi
done
synced=0
for f in "$SRC"/*.json; do
  base=$(basename "$f")
  if is_forked "$base"; then
    continue
  fi
  cp "$f" "$DST/$base"
  synced=$((synced + 1))
done
echo "Synced $synced dashboards into $DST (left ${#FORKED_DASHBOARDS[@]} forked dashboards untouched: ${FORKED_DASHBOARDS[*]})."
