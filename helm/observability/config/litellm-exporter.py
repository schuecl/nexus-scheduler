# LiteLLM gateway -> Prometheus bridge (litellm-exporter service in
# docker-compose.observability.yml). The OSS LiteLLM proxy has no
# /metrics endpoint (Prometheus export is an enterprise feature —
# verified 404), but every call it routes is metered in its spend log.
# This exporter turns GET /spend/logs into the counters the AI
# Consumption & Cost dashboard needs, labelled by model and virtual-key
# alias:
#
#   litellm_gateway_requests_total{model,key_alias,call_type}
#   litellm_gateway_tokens_total{model,key_alias,type="prompt"|"completion"}
#   litellm_gateway_spend_usd_total{model,key_alias}
#   litellm_gateway_mcp_calls_total{tool,key_alias}
#   litellm_gateway_up  (1 = the last poll of /spend/logs succeeded)
#
# call_type distinguishes what the gateway actually did (completion,
# embedding, ...), and MCP tool invocations routed through the gateway
# surface separately under litellm_gateway_mcp_calls_total — so "model
# call" and "MCP tool call" are answerable as different questions.
#
# Totals are recomputed from the full spend log on every scrape — the
# right trade-off for a dev stack (idempotent, no state, survives
# restarts without counter resets going unnoticed; Prometheus counters
# may go DOWN only if the LiteLLM DB is wiped, which a dev `down -v`
# legitimately does). Stdlib only, so it runs in the same image as the
# litellm service itself.
import json
import os
import urllib.error
import urllib.request
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, HTTPServer

LITELLM_URL = os.environ.get("LITELLM_URL", "http://litellm:4000")
MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
PORT = int(os.environ.get("PORT", "9099"))


def fetch_spend_logs():
    req = urllib.request.Request(
        # summarize=false pins the per-transaction row shape (completion_tokens
        # et al). The bare endpoint already returns individual rows on the
        # image this was verified against, but LiteLLM flips to summarized
        # aggregate rows in some modes (e.g. date-filtered queries), so ask
        # explicitly rather than depend on the default.
        LITELLM_URL + "/spend/logs?summarize=false",
        headers={"Authorization": "Bearer " + MASTER_KEY},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def esc(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"')


def render():
    lines = [
        "# TYPE litellm_gateway_up gauge",
        "# TYPE litellm_gateway_requests_total counter",
        "# TYPE litellm_gateway_mcp_calls_total counter",
        "# TYPE litellm_gateway_tokens_total counter",
        "# TYPE litellm_gateway_spend_usd_total counter",
    ]
    try:
        rows = fetch_spend_logs()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
        # Gateway absent (pre-#102 stack) or unreachable: report down,
        # export nothing stale.
        lines.append("litellm_gateway_up 0")
        return "\n".join(lines) + "\n"

    requests = defaultdict(int)
    tokens = defaultdict(int)
    spend = defaultdict(float)
    mcp = defaultdict(int)
    for row in rows:
        model = row.get("model") or "(none)"
        alias = (row.get("metadata") or {}).get("user_api_key_alias") or "(none)"
        call_type = row.get("call_type") or "(none)"
        mcp_tool = row.get("mcp_namespaced_tool_name")
        if mcp_tool:
            mcp[(mcp_tool, alias)] += 1
        requests[(model, alias, call_type)] += 1
        tokens[(model, alias, "prompt")] += int(row.get("prompt_tokens") or 0)
        tokens[(model, alias, "completion")] += int(row.get("completion_tokens") or 0)
        spend[(model, alias)] += float(row.get("spend") or 0.0)

    lines.append("litellm_gateway_up 1")
    for (m, a, ct), v in sorted(requests.items()):
        lines.append(f'litellm_gateway_requests_total{{model="{esc(m)}",key_alias="{esc(a)}",call_type="{esc(ct)}"}} {v}')
    for (t, a), v in sorted(mcp.items()):
        lines.append(f'litellm_gateway_mcp_calls_total{{tool="{esc(t)}",key_alias="{esc(a)}"}} {v}')
    for (m, a, t), v in sorted(tokens.items()):
        lines.append(f'litellm_gateway_tokens_total{{model="{esc(m)}",key_alias="{esc(a)}",type="{t}"}} {v}')
    for (m, a), v in sorted(spend.items()):
        lines.append(f'litellm_gateway_spend_usd_total{{model="{esc(m)}",key_alias="{esc(a)}"}} {v}')
    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return
        body = render().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # scrapes every 15s; don't fill the log with them


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
