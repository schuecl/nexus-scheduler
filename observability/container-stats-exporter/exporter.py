# Docker-API container stats -> Prometheus bridge (container-stats-exporter
# service, `docker-desktop` compose profile). On Docker Desktop
# (macOS/Windows) cAdvisor's cgroup mounts see the VM, not the containers,
# so the per-container panels on the Infrastructure/Overview dashboards
# read "No data" there. This exporter gets the same numbers from the
# Docker Engine API (/containers/{id}/stats) over the mounted socket —
# which works identically on every platform — and emits them under the
# cAdvisor metric names those panels already query:
#
#   container_memory_working_set_bytes{name}
#   container_cpu_usage_seconds_total{name}
#   container_oom_events_total{name}
#   container_stats_exporter_up
#
# OOM kills come from the Engine events API (/events, event=oom), counted
# since exporter start — cAdvisor's kernel-log source is equally invisible
# on Docker Desktop, so without this the Infrastructure dashboard's OOM
# panel could never populate there (issue #126).
#
# It is profile-gated OFF by default: on a Linux host cAdvisor works and
# running both would double-count every sum by (name). Enable it only on
# Docker Desktop:  docker compose --profile docker-desktop up -d
#
# Stdlib-only; runs in the same image as the litellm service. One
# sequential stats poll per scrape (stream=false, ~10ms per container).
import http.client
import json
import os
import socket
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

DOCKER_SOCK = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")
# Scope to this Compose project — the Engine API sees every container on
# the host, and (as with Alloy's log discovery) leaking other projects'
# workloads into dashboards served with anonymous admin is not okay.
COMPOSE_PROJECT = os.environ.get("COMPOSE_PROJECT", "nexus-scheduler")
PORT = int(os.environ.get("PORT", "9101"))
# OOM events are counted from process start, incrementally: each scrape
# queries only the window since the previous one and folds new events
# into these tallies, so scrape cost stays proportional to what happened
# since the last scrape instead of growing with process age. The counter
# stays monotonic for as long as the exporter lives; a restart is an
# ordinary counter reset that increase()/rate() already handle.
# Windows overlap by up to a second (the events API takes whole-second
# bounds), so _oom_last_nano deduplicates boundary events by their
# nanosecond timestamp. HTTPServer serves requests serially — no lock.
_oom_counts = {}
_oom_since = int(time.time())
_oom_last_nano = 0


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, sock_path):
        super().__init__("localhost")
        self.sock_path = sock_path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect(self.sock_path)
        self.sock = s


def docker_get(path):
    conn = UnixHTTPConnection(DOCKER_SOCK)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return json.load(resp)
    finally:
        conn.close()


def docker_get_ndjson(path):
    # /events responds with one JSON object per line (and closes the
    # stream itself once `until` is in the past), unlike every other
    # endpoint this exporter touches.
    conn = UnixHTTPConnection(DOCKER_SOCK)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        events = []
        for line in resp.read().splitlines():
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
        return events
    finally:
        conn.close()


def oom_counts():
    # cAdvisor's container_oom_events_total comes from the kernel log,
    # which is just as invisible on Docker Desktop as the cgroup tree —
    # the Engine's event stream is the platform-independent source for
    # the same fact (State.OOMKilled flips are also visible there as
    # discrete `oom` events, one per kill).
    #
    # Keyed by container NAME, not Actor.ID, on purpose: it mirrors
    # cAdvisor's `name` label, which is what the dashboard's
    # sum by (name)(increase(...)) queries aggregate on — a compose
    # service that gets recreated keeps its kill history under the one
    # series an operator is actually watching.
    global _oom_since, _oom_last_nano
    filters = urllib.parse.quote(
        json.dumps(
            {
                "type": ["container"],
                "event": ["oom"],
                "label": [f"com.docker.compose.project={COMPOSE_PROJECT}"],
            }
        )
    )
    until = max(int(time.time()), _oom_since)
    events = docker_get_ndjson(
        f"/events?since={_oom_since}&until={until}&filters={filters}"
    )
    prev_high_water = _oom_last_nano
    for event in events:
        nano = event.get("timeNano") or 0
        if nano <= prev_high_water:
            continue  # replayed by the one-second window overlap
        name = ((event.get("Actor") or {}).get("Attributes") or {}).get("name")
        if name:
            _oom_counts[name] = _oom_counts.get(name, 0) + 1
            _oom_last_nano = max(_oom_last_nano, nano)
    _oom_since = until
    return dict(_oom_counts)


def esc(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"')


def render():
    lines = [
        "# TYPE container_stats_exporter_up gauge",
        "# TYPE container_memory_working_set_bytes gauge",
        "# TYPE container_cpu_usage_seconds_total counter",
        "# TYPE container_oom_events_total counter",
    ]
    try:
        filters = urllib.parse.quote(json.dumps({"label": [f"com.docker.compose.project={COMPOSE_PROJECT}"]}))
        containers = docker_get(f"/containers/json?filters={filters}")
    except OSError:
        lines.append("container_stats_exporter_up 0")
        return "\n".join(lines) + "\n"

    lines.append("container_stats_exporter_up 1")

    try:
        ooms = oom_counts()
    except OSError:
        # Events endpoint down: keep reporting what's already been
        # counted — a counter that dips to zero and back reads as a
        # reset plus phantom kills to increase().
        ooms = dict(_oom_counts)
    # Zero-seed every running container so the OOM panel gets a real
    # series (a flat 0) instead of "No data" — an absent series and "no
    # kills yet" must not look identical, that ambiguity is issue #126.
    for c in containers:
        name = (c.get("Names") or ["/?"])[0].lstrip("/")
        ooms.setdefault(name, 0)
    for name, count in sorted(ooms.items()):
        lines.append(f'container_oom_events_total{{name="{esc(name)}"}} {count}')
    for c in containers:
        name = (c.get("Names") or ["/?"])[0].lstrip("/")
        try:
            stats = docker_get(f"/containers/{c['Id']}/stats?stream=false&one-shot=true")
        except OSError:
            continue
        mem = stats.get("memory_stats") or {}
        usage = mem.get("usage")
        if usage is None:
            continue
        # Same definition cAdvisor uses for working set: usage minus
        # reclaimable page cache. cgroup v2 daemons report it as
        # inactive_file; cgroup v1 as total_inactive_file — check both
        # or v1 hosts silently export total usage as working set.
        mstats = mem.get("stats") or {}
        inactive = mstats.get("inactive_file") or mstats.get("total_inactive_file") or 0
        working_set = max(usage - inactive, 0)
        cpu_ns = ((stats.get("cpu_stats") or {}).get("cpu_usage") or {}).get("total_usage")
        lines.append(f'container_memory_working_set_bytes{{name="{esc(name)}"}} {working_set}')
        if cpu_ns is not None:
            lines.append(f'container_cpu_usage_seconds_total{{name="{esc(name)}"}} {cpu_ns / 1e9}')
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
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
