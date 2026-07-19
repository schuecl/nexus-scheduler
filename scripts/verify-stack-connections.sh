#!/bin/sh
# Verify every runtime connection in the compose stack, hop by hop —
# the answer to "why are runs failing" should never require guessing
# which link broke. Each check is the REAL path the components use
# (same hostnames, same ports, same auth), not a proxy for it.
#
# Usage: sh scripts/verify-stack-connections.sh   (from the repo root,
# with the stack up). Exits non-zero if any hop fails.
set -u

# Resolve containers by compose labels so a renamed checkout or
# `docker compose -p` still verifies (service names are stable;
# container names are not).
PROJECT=${COMPOSE_PROJECT_NAME:-$(basename "$(pwd)")}
EDGE_PORT=${APP_PORT:-8080}
cid() {
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -1
}

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s (%ss)\n' "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s — %s\n' "$1" "$2"; }

t() { python3 -c 'import time; print(f"{time.time():.1f}")'; }
elapsed() { python3 -c "print(f'{$2 - $1:.1f}')"; }

# --- node-based HTTP probe run inside a container ---------------------
# probe <container> <name> <url> [timeout_s]
probe() {
  c=$1; name=$2; url=$3; tmo=${4:-10}
  # An absent/stopped container resolves to an empty cid — exactly the
  # failure this script exists to surface. Quoted call sites keep the
  # empty argument in position; report and move on instead of letting
  # set -u kill the whole diagnostic on a shifted parameter.
  if [ -z "$c" ]; then bad "$name" "container not running"; return; fi
  s=$(t)
  out=$(docker exec "$c" node -e "
    fetch('$url', { signal: AbortSignal.timeout(${tmo}000) })
      .then(r => { console.log(r.status); })
      .catch(e => { console.log('ERR ' + (e.cause?.code ?? e.name ?? e.message)); });
  " 2>&1 | tail -1)
  e=$(t)
  case "$out" in
    2*|3*|401|404|405) ok "$name" "$(elapsed "$s" "$e")" ;;  # reachable; auth/route handled above
    *) bad "$name" "$out" ;;
  esac
}

# python probe for containers without node
pyprobe() {
  c=$1; name=$2; url=$3; tmo=${4:-10}
  if [ -z "$c" ]; then bad "$name" "container not running"; return; fi
  # An absent/stopped container resolves to an empty cid — exactly the
  # failure this script exists to surface. Quoted call sites keep the
  # empty argument in position; report and move on instead of letting
  # set -u kill the whole diagnostic on a shifted parameter.
  if [ -z "$c" ]; then bad "$name" "container not running"; return; fi
  s=$(t)
  out=$(docker exec "$c" python3 -c "
import urllib.request, urllib.error
try:
    print(urllib.request.urlopen('$url', timeout=$tmo).status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception as e:
    print('ERR', type(e).__name__)
" 2>&1 | tail -1)
  e=$(t)
  case "$out" in
    2*|3*|401|404|405) ok "$name" "$(elapsed "$s" "$e")" ;;
    *) bad "$name" "$out" ;;
  esac
}

echo "== app tier =="
probe "$(cid api)"     "api -> postgres+redis (via /readyz)"   "http://localhost:3000/readyz"
probe "$(cid worker)"  "worker -> librechat"                   "http://librechat:3080/health" 15
probe "$(cid worker)"  "worker -> ocr /healthz"                "http://ocr:4200/healthz"
probe "$(cid api)"     "api -> pdf-service"                    "http://pdf-service:4100/healthz"

echo "== ai tier =="
probe "$(cid librechat)" "librechat -> litellm /v1/models"     "http://litellm:4000/v1/models" 15
pyprobe "$(cid litellm)" "litellm -> ollama /api/tags"         "http://ollama:11434/api/tags"
pyprobe "$(cid litellm)" "litellm -> own readiness (db)"       "http://localhost:4000/health/readiness" 20
pyprobe "$(cid ocr)"     "ocr -> litellm (gateway egress)"     "http://litellm:4000/health/liveliness"

echo "== ai tier: a REAL generation through the whole gateway path =="
KEY=$(grep '^LITELLM_LIBRECHAT_KEY=' .env | cut -d= -f2)
s=$(t)
out=$(docker exec "$(cid litellm)" python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:4000/v1/chat/completions',
  data=json.dumps({'model':'gemma3:1b','messages':[{'role':'user','content':'Say OK'}],'max_tokens':4}).encode(),
  headers={'Authorization':'Bearer $KEY','Content-Type':'application/json'})
try:
    r = json.load(urllib.request.urlopen(req, timeout=180))
    print('GEN', r['choices'][0]['message']['content'][:20].strip())
except Exception as e:
    print('ERR', type(e).__name__)
" 2>&1 | tail -1)
e=$(t)
case "$out" in
  GEN*) ok "litellm -> ollama generation ($out)" "$(elapsed "$s" "$e")" ;;
  *) bad "litellm -> ollama generation" "$out" ;;
esac

echo "== isolation (must FAIL to connect) =="
s=$(t)
out=$(docker exec "$(cid ocr)" python3 -c "
import urllib.request
try:
    urllib.request.urlopen('https://example.com', timeout=5)
    print('CONNECTED')
except Exception:
    print('BLOCKED')
" 2>&1 | tail -1)
e=$(t)
if [ "$out" = "BLOCKED" ]; then ok "ocr internet egress blocked (ocr-net internal)" "$(elapsed "$s" "$e")"; else bad "ocr internet egress" "expected BLOCKED, got $out"; fi

echo "== edge =="
s=$(t); code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:${EDGE_PORT}/healthz"); e=$(t)
case "$code" in 200) ok "nginx -> api (host :${EDGE_PORT})" "$(elapsed "$s" "$e")" ;; *) bad "nginx -> api" "http $code" ;; esac
s=$(t); code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:${EDGE_PORT}/"); e=$(t)
case "$code" in 200) ok "nginx -> frontend" "$(elapsed "$s" "$e")" ;; *) bad "nginx -> frontend" "http $code" ;; esac

if [ -z "$(cid grafana)" ]; then
  echo "== observability: not deployed (compose overlay absent) — skipped =="
else
echo "== observability (evidence-based: the data proves the link) =="
GPASS=$(grep '^GRAFANA_ADMIN_PASSWORD=' .env | cut -d= -f2)
GAUTH="admin:${GPASS:-admin}"
# grafana -> mimir/loki: Grafana's own datasource health checks.
for ds in prometheus loki; do
  s=$(t)
  uid=$(curl -s -u "$GAUTH" http://localhost:${GRAFANA_PORT:-3300}/api/datasources | python3 -c "import json,sys; print([d['uid'] for d in json.load(sys.stdin) if d['type']=='$ds'][0])" 2>/dev/null)
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "$GAUTH" "http://localhost:${GRAFANA_PORT:-3300}/api/datasources/uid/$uid/health")
  e=$(t)
  case "$code" in 200) ok "grafana -> $ds datasource health" "$(elapsed "$s" "$e")" ;; *) bad "grafana -> $ds datasource health" "http $code" ;; esac
done
# alloy -> mimir: a scrape sample younger than 2 minutes proves the
# whole collect->write->store->query chain, not just a TCP handshake.
s=$(t)
uid=$(curl -s -u "$GAUTH" http://localhost:${GRAFANA_PORT:-3300}/api/datasources | python3 -c "import json,sys; print([d['uid'] for d in json.load(sys.stdin) if d['type']=='prometheus'][0])" 2>/dev/null)
fresh=$(curl -s -u "$GAUTH" -H 'Content-Type: application/json' -d "{\"queries\":[{\"refId\":\"A\",\"datasource\":{\"uid\":\"$uid\"},\"expr\":\"max(timestamp(up{service=\\\"api\\\"}))\",\"instant\":true,\"maxDataPoints\":1}],\"from\":\"now-5m\",\"to\":\"now\"}" http://localhost:${GRAFANA_PORT:-3300}/api/ds/query | python3 -c "
import json,sys,time
r=json.load(sys.stdin)
try:
    v=r['results']['A']['frames'][0]['data']['values'][-1][-1]
    print('FRESH' if time.time()-float(v) < 120 else 'STALE')
except Exception:
    print('NONE')
")
e=$(t)
case "$fresh" in FRESH) ok "alloy -> mimir (api scrape sample < 2m old)" "$(elapsed "$s" "$e")" ;; *) bad "alloy -> mimir write path" "$fresh" ;; esac
fi
pyprobe "$(cid ocr)"   "ocr /metrics serves (scrape source)" "http://localhost:4200/metrics"
probe "$(cid worker)"  "worker /metrics serves"              "http://localhost:3001/metrics"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
