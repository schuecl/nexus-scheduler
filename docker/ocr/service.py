# OCR pipeline service (#109). One path for every input, per the issue's
# design — the decision "does this need OCR?" is never written down,
# because ocrmypdf --skip-text makes it per page:
#
#   image(s) --img2pdf--> pdf --ocrmypdf --skip-text--> searchable.pdf
#                                  (Tesseract runs ONCE, only on pages
#                                   with no text layer)
#                                         |
#                        docling(do_ocr=False) --> markdown + tables
#
# do_ocr=False is load-bearing: OCRmyPDF's output keeps the original
# page image, so bitmap coverage stays ~100% and docling's
# coverage>0.75 branch would re-OCR every page and then discard the
# result. With it, docling builds layout/tables from the text layer the
# single Tesseract pass already produced.
#
# Optional image description ("what is this about?" — which OCR cannot
# answer): set GATEWAY_URL/GATEWAY_KEY/VISION_MODEL and /process will
# also ask the model gateway to describe image inputs. Off when unset;
# the airgap acceptance runs without it or with a local vision model.
import asyncio
import base64
import http.client
import io
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.request
import json as jsonlib
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile, HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.datastructures import Headers
from fastapi.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from PIL import Image, UnidentifiedImageError


from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Histogram,
    generate_latest,
)

app = FastAPI(title="nexus-ocr")


# Validation failures (missing/malformed multipart, bad JSON shape)
# short-circuit in FastAPI before any handler runs — without this hook
# they'd be invisible to nexus_ocr_requests_total and the error-ratio
# panel would understate real client failures.
@app.exception_handler(RequestValidationError)
async def _count_validation_errors(request: Request, exc: RequestValidationError):
    if request.url.path.rstrip("/") not in ("/healthz", "/metrics"):
        REQUESTS.labels(outcome="client_error").inc()
    return JSONResponse(status_code=422, content={"detail": exc.errors()[:5]})

# Metrics, one story per question an operator asks (same naming
# convention as the app's nexus_scheduler_* families):
#   is it working?      nexus_ocr_requests_total{outcome}
#   how much OCR?       nexus_ocr_pages_total{disposition}  (ocred|skipped
#                       — skipped = digital passthrough, the zero-cost path)
#   where does time go? nexus_ocr_stage_duration_seconds{stage}
#   what comes in?      nexus_ocr_input_files_total{kind}
REQUESTS = Counter(
    "nexus_ocr_requests_total",
    "Document-processing requests, by outcome",
    ["outcome"],  # success | client_error | server_error
)
PAGES = Counter(
    "nexus_ocr_pages_total",
    "Pages processed, by disposition — ocred went through Tesseract, skipped already had a text layer",
    ["disposition"],  # ocred | skipped
)
STAGE_DURATION = Histogram(
    "nexus_ocr_stage_duration_seconds",
    "Wall time per pipeline stage of a /process request",
    ["stage"],  # img2pdf | ocrmypdf | docling | describe | total
    buckets=[0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
)
INPUT_FILES = Counter(
    "nexus_ocr_input_files_total",
    "Uploaded input files, by concrete type",
    ["kind"],  # pdf | png | jpeg | tiff | bmp | webp
)
DOC_PAGES = Histogram(
    "nexus_ocr_document_pages",
    "Pages per processed document (a multi-image batch is one document; every page counts whether OCR'd or passed through)",
    buckets=[1, 2, 3, 5, 10, 20, 50, 100, 250],
)
DESCRIPTIONS = Counter(
    "nexus_ocr_descriptions_total",
    "Vision-model image descriptions, by outcome",
    ["outcome"],  # returned | unavailable
)

IMAGE_TYPES = {"image/png", "image/jpeg", "image/tiff", "image/bmp", "image/webp"}
# img2pdf deliberately accepts only formats it can embed losslessly; BMP
# and WebP are not among them even though they are valid scheduler inputs.
# Normalize just those two formats to PNG before invoking img2pdf. Keep the
# original payload separately for the optional vision description.
IMG2PDF_TRANSCODE_TYPES = {"image/bmp", "image/webp"}
PDF_TYPE = "application/pdf"
# Shared public ceilings for scheduler attachments, LibreChat uploads,
# and the direct OCR routes.
_FILE_MAX_BYTES = 15 * 1024 * 1024
_PROCESS_MAX_FILES = 10
_PROCESS_MAX_TOTAL_BYTES = 50 * 1024 * 1024
_FILE_MAX_B64_CHARS = 4 * ((_FILE_MAX_BYTES + 2) // 3)
# Multipart boundaries/headers and the small JSON/data-URL wrapper need
# bounded headroom beyond the actual file bytes. This is a wire limit,
# enforced while receiving ASGI chunks before Starlette parses/spools them.
_REQUEST_OVERHEAD_BYTES = 64 * 1024
_REQUEST_BODY_LIMITS = {
    "/process": _PROCESS_MAX_TOTAL_BYTES + _REQUEST_OVERHEAD_BYTES,
    "/files": _FILE_MAX_BYTES + _REQUEST_OVERHEAD_BYTES,
    "/v1/files": _FILE_MAX_BYTES + _REQUEST_OVERHEAD_BYTES,
    "/ocr": _FILE_MAX_B64_CHARS + _REQUEST_OVERHEAD_BYTES,
    "/v1/ocr": _FILE_MAX_B64_CHARS + _REQUEST_OVERHEAD_BYTES,
}
# Photos and PNGs frequently carry no DPI metadata; without a default
# ocrmypdf refuses the input outright (issue #109's diagram).
IMAGE_DPI = os.environ.get("IMAGE_DPI", "300")
# Hard per-request ceiling on /process work. A client that disconnects
# mid-OCR (the worker aborts its fetch when the run budget expires)
# doesn't stop a sync handler — the subprocesses would grind on as
# orphans and accumulate until the service is unavailable. Callers pass
# their remaining budget as ?budget_seconds; the server enforces
# min(budget, this ceiling) by timing out the subprocess stages, so
# abandoned work self-terminates at the moment its client gave up on it.
MAX_PROCESS_SECONDS = float(os.environ.get("OCR_MAX_PROCESS_SECONDS", "900"))


class _RequestBodyTooLarge(HTTPException):
    def __init__(self, limit: int):
        super().__init__(status_code=413, detail=f"request body exceeds {limit} bytes")


@app.exception_handler(_RequestBodyTooLarge)
async def _handle_request_body_too_large(request: Request, exc: _RequestBodyTooLarge):
    REQUESTS.labels(outcome="client_error").inc()
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers={"Connection": "close"},
    )


class _RequestBodyLimitMiddleware:
    def __init__(self, asgi_app: ASGIApp):
        self.asgi_app = asgi_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self.asgi_app(scope, receive, send)
            return
        limit = _REQUEST_BODY_LIMITS.get(scope.get("path", ""))
        if limit is None:
            await self.asgi_app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        try:
            content_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            content_length = 0
        if content_length > limit:
            REQUESTS.labels(outcome="client_error").inc()
            await JSONResponse(
                status_code=413,
                content={"detail": f"request body exceeds {limit} bytes"},
                headers={"Connection": "close"},
            )(scope, receive, send)
            return

        received = 0

        async def bounded_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # FastAPI deliberately preserves HTTPException while
                    # converting arbitrary body-parser failures into a 400.
                    # Use the HTTP form so the route-specific 413 survives
                    # multipart parsing and reaches the handler above.
                    raise _RequestBodyTooLarge(limit)
            return message

        await self.asgi_app(scope, bounded_receive, send)


app.add_middleware(_RequestBodyLimitMiddleware)


def _write_img2pdf_input(data: bytes, mime: str, path: Path) -> Path:
    if mime not in IMG2PDF_TRANSCODE_TYPES:
        path.write_bytes(data)
        return path

    normalized_path = path.with_suffix(".png")
    try:
        with Image.open(io.BytesIO(data)) as source:
            # One uploaded image is one document page. Animated WebP is
            # therefore handled like other multi-frame image formats here:
            # the first frame is the uploaded page.
            source.seek(0)
            if source.mode in ("RGBA", "LA") or "transparency" in source.info:
                rgba = source.convert("RGBA")
                normalized = Image.new("RGB", rgba.size, "white")
                normalized.paste(rgba, mask=rgba.getchannel("A"))
                rgba.close()
            else:
                normalized = source.convert("RGB")
            try:
                normalized.save(normalized_path, format="PNG")
            finally:
                normalized.close()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
        raise HTTPException(422, f"invalid {mime} image") from exc
    return normalized_path


def _remaining(deadline: float, stage: str) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise HTTPException(408, f"processing budget exhausted before {stage}")
    return left

GATEWAY_URL = os.environ.get("GATEWAY_URL", "")
GATEWAY_KEY = os.environ.get("GATEWAY_KEY", "")
VISION_MODEL = os.environ.get("VISION_MODEL", "")
# Default describe behavior for callers that carry no per-request flag —
# specifically the Mistral /v1/ocr path (LibreChat chat uploads), which
# has no way to pass ?describe. The /process path still honors its
# explicit per-request describe flag. Only ever takes effect when the
# gateway trio above is also configured.
DESCRIBE_IMAGES = os.environ.get("OCR_DESCRIBE_IMAGES", "false").strip().lower() in ("1", "true", "yes", "on")
# Floor for the vision-description budget. The describe stage runs after
# OCR/docling; when a caller passes a tight budget_seconds most of it is
# already spent, leaving too little for a CPU vision model and yielding
# a silent "unavailable". Guarantee this much for a description attempt
# so the feature isn't starved by upstream stages (still bounded by the
# gateway timeout and cancellation).
DESCRIBE_MIN_BUDGET_S = float(os.environ.get("OCR_DESCRIBE_MIN_BUDGET_S", "60"))


def _log(msg: str) -> None:
    print(f"[ocr] {msg}", file=sys.stderr, flush=True)

# Docling runs in a persistent, killable child process (docling_worker.py)
# rather than in-process: an in-process conversion cannot be interrupted,
# so a request whose client already disconnected would keep a CPU busy
# past its own deadline — the orphaned-work condition ?budget_seconds
# exists to prevent. The child loads models once at spawn (same warm
# behavior as the old in-process converter); on deadline overrun it is
# killed and respawned. One conversion at a time under a lock, with lock
# acquisition itself bounded by the caller's remaining budget.
# Cancellable in-flight /process requests: the worker names each
# request (?request_id=) and, when a user cancels the run, POSTs
# /process/{id}/cancel — disconnecting alone can't stop a sync handler
# mid-subprocess. State per id: {"cancelled", "proc"} where proc is the
# currently running tracked subprocess (killed on cancel). A cancel for
# an id not yet registered is remembered (pre-cancel) so the race
# "cancel arrives before the upload finishes parsing" still lands.
_INFLIGHT: dict[str, dict] = {}
_INFLIGHT_LOCK = threading.Lock()
# Pre-cancellations (a cancel for an id with no live /process — either
# the upload hasn't reached its handler yet, or it already finished)
# carry a timestamp and are garbage-collected: without a TTL and size
# bound, every cancel that races its request's own completion — or any
# ocr-net client POSTing arbitrary ids — would grow this map forever.
# Live entries (registered by a running /process) have no "pre" key and
# are never GC'd; their handler's finally removes them.
_PRECANCEL_TTL_SECONDS = 600
_PRECANCEL_MAX = 1024


def _inflight_gc_locked() -> None:
    now = time.monotonic()
    expired = [k for k, v in _INFLIGHT.items() if "pre" in v and now - v["pre"] > _PRECANCEL_TTL_SECONDS]
    for k in expired:
        _INFLIGHT.pop(k, None)
    pre = [(v["pre"], k) for k, v in _INFLIGHT.items() if "pre" in v]
    if len(pre) > _PRECANCEL_MAX:
        for _, k in sorted(pre)[: len(pre) - _PRECANCEL_MAX]:
            _INFLIGHT.pop(k, None)


def _inflight_register(request_id: str | None) -> dict | None:
    if not request_id:
        return None
    with _INFLIGHT_LOCK:
        _inflight_gc_locked()
        state = _INFLIGHT.get(request_id)
        if state is None:
            state = {"cancelled": False, "proc": None}
            _INFLIGHT[request_id] = state
        else:
            # Claiming a pre-cancelled id: it's live now, exempt from GC
            # (the handler's finally owns removal from here).
            state.pop("pre", None)
        return state


def _inflight_unregister(request_id: str | None) -> None:
    if request_id:
        with _INFLIGHT_LOCK:
            _INFLIGHT.pop(request_id, None)


def _check_cancelled(state: dict | None) -> None:
    if state is not None and state["cancelled"]:
        raise HTTPException(499, "request cancelled by the client")


def _kill_process_group(proc: subprocess.Popen) -> None:
    # ocrmypdf forks Tesseract children; killing only the wrapper would
    # leave them grinding on as exactly the orphaned work this tracking
    # exists to prevent. Each tracked command runs as its own session
    # leader (start_new_session below), so its pgid == its pid and the
    # whole tree dies together.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def _cancel_state(state: dict) -> None:
    """Mark a request cancelled and stop its active subprocess, if any."""
    with _INFLIGHT_LOCK:
        state["cancelled"] = True
        proc = state.get("proc")
        if proc is not None:
            _kill_process_group(proc)


def _run_tracked(args: list[str], state: dict | None, timeout: float) -> subprocess.CompletedProcess:
    """subprocess.run, but registered so a cancel can kill it mid-flight."""
    proc = subprocess.Popen(
        args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True
    )
    if state is not None:
        with _INFLIGHT_LOCK:
            if state["cancelled"]:
                _kill_process_group(proc)
            state["proc"] = proc
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc)
        raise
    finally:
        if state is not None:
            with _INFLIGHT_LOCK:
                state["proc"] = None
    _check_cancelled(state)
    return subprocess.CompletedProcess(args, proc.returncode, out, err)


_DOCLING_LOCK = threading.Lock()
_docling_proc: subprocess.Popen | None = None


def _docling_spawn() -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-u", str(Path(__file__).parent / "docling_worker.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def _has_extractable_text(markdown: str) -> bool:
    # docling emits "<!-- image -->" placeholders for pages it treats as
    # pictures; strip those (and markdown noise) to decide whether any
    # real text survived.
    stripped = re.sub(r"<!--\s*image\s*-->", "", markdown)
    stripped = re.sub(r"[#*_>`\-\s]", "", stripped)
    return bool(stripped)


def _extract_pdf_text_layer(pdf_path: Path) -> str:
    # Fallback text extraction straight from the searchable PDF's text
    # layer (the one ocrmypdf wrote) when docling drops it. pypdfium2 is
    # already a dependency (docling pulls it); import lazily so a missing
    # optional never breaks the main path.
    try:
        import pypdfium2 as pdfium
    except Exception:
        return ""
    try:
        doc = pdfium.PdfDocument(str(pdf_path))
    except Exception:
        return ""
    try:
        pages = []
        for page in doc:
            textpage = page.get_textpage()
            pages.append(textpage.get_text_bounded().strip())
            textpage.close()
            page.close()
        return "\n\n".join(p for p in pages if p)
    finally:
        doc.close()


def _docling_convert(pdf_path: Path, out_path: Path, deadline: float, state: dict | None = None) -> None:
    global _docling_proc
    # Lock acquisition in short slices, not one long block: a cancelled
    # request queued behind another conversion would otherwise hold its
    # FastAPI thread for the whole remaining budget and then pointlessly
    # submit (and kill) a conversion nobody wants.
    while True:
        if state is not None and state["cancelled"]:
            raise HTTPException(499, "request cancelled by the client")
        if _DOCLING_LOCK.acquire(timeout=min(0.5, _remaining(deadline, "docling"))):
            break

    def _kill_reset() -> None:
        # Any exit between spawn/request-write and response-read leaves
        # the child's line protocol out of phase (an unread ready line or
        # a late conversion response would pair with the NEXT request and
        # corrupt every call until pod restart) — so those paths always
        # kill and clear, trading one model reload for correctness.
        global _docling_proc
        if _docling_proc is not None:
            _docling_proc.kill()
            _docling_proc.wait()
            _docling_proc = None

    try:
        if _docling_proc is None or _docling_proc.poll() is not None:
            _docling_proc = _docling_spawn()
            # The child prints {"ready": true} once models are loaded;
            # consume it (bounded by the caller's budget, WITHOUT the
            # raising helper — a raise here would skip the reset and
            # desync the protocol) so request/response lines stay paired
            # one-to-one from here on.
            left = deadline - time.monotonic()
            ready = select.select([_docling_proc.stdout], [], [], left)[0] if left > 0 else []
            if not ready:
                _kill_reset()
                raise HTTPException(408, "processing budget exhausted while docling models loaded")
            _docling_proc.stdout.readline()
        proc = _docling_proc
        proc.stdin.write(jsonlib.dumps({"pdf": str(pdf_path), "out": str(out_path)}) + "\n")
        proc.stdin.flush()
        # Short ticks instead of one long select: each tick re-checks
        # the request's cancel flag, so a cancelled client stops this
        # conversion within ~0.5s instead of at the budget ceiling.
        # Plain arithmetic, never the raising helper: from here until
        # the response line is consumed, every early exit must reset.
        while True:
            cancelled = state is not None and state["cancelled"]
            left = deadline - time.monotonic()
            if cancelled or left <= 0:
                _kill_reset()
                if cancelled:
                    raise HTTPException(499, "request cancelled by the client")
                raise HTTPException(408, "processing budget exhausted during docling conversion")
            readable, _, _ = select.select([proc.stdout], [], [], min(0.5, left))
            if readable:
                break
        line = proc.stdout.readline()
        if not line:
            _docling_proc = None
            raise HTTPException(500, "docling worker exited unexpectedly")
        resp = jsonlib.loads(line)
        if not resp.get("ok"):
            raise HTTPException(422, f"docling conversion failed: {resp.get('error', '')[:300]}")
    finally:
        _DOCLING_LOCK.release()


# Warm start: spawn the child and wait for its ready line now, at
# service startup — exactly when the old in-process converter paid its
# model-load cost — so the first request converts immediately. The line
# is VALIDATED: a child that dies during model load (corrupt artifacts,
# OOM kill) yields an empty readline, and silently proceeding would
# expose a 200 /healthz on a pod that fails every document request —
# compose/Helm would mark a nonfunctional OCR service ready.
_docling_proc = _docling_spawn()
assert _docling_proc.stdout is not None
_ready_line = _docling_proc.stdout.readline()
try:
    _ready_ok = bool(_ready_line) and jsonlib.loads(_ready_line).get("ready") is True
except ValueError:
    _ready_ok = False
if not _ready_ok:
    raise RuntimeError(
        "docling worker failed to initialize (no ready message) — refusing to start; "
        "check DOCLING_ARTIFACTS_PATH and the container memory limit"
    )


def _describe_image(
    data: bytes, mime: str, timeout: float = 240.0, state: dict | None = None
) -> str | None:
    if not (GATEWAY_URL and GATEWAY_KEY and VISION_MODEL):
        return None
    # The gateway call runs in a short-lived daemon thread polled in
    # 0.25s ticks: a blocking call here would hold one of FastAPI's
    # threadpool workers for up to the full gateway timeout after the
    # client cancelled — repeated cancels could exhaust the pool. The
    # connection object is owned OUTSIDE the thread so cancel/deadline
    # can close it: closing unblocks the thread within a tick, which
    # releases the request payload (base64 image, up to ~20MB) instead
    # of retaining it until the socket timeout expires.
    parsed = urllib.parse.urlsplit(GATEWAY_URL)
    if parsed.scheme == "https":
        connection_type = http.client.HTTPSConnection
        default_port = 443
    elif parsed.scheme == "http":
        connection_type = http.client.HTTPConnection
        default_port = 80
    else:
        # Description is optional, but an unsupported scheme must never be
        # treated as plaintext HTTP to an arbitrary default port.
        return None
    conn = connection_type(parsed.hostname, parsed.port or default_port, timeout=timeout)
    payload = jsonlib.dumps({
        "model": VISION_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image in two sentences: what it shows and any notable details."},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}},
            ],
        }],
        "max_tokens": 200,
    })
    result: list[str | None] = []

    def _call() -> None:
        try:
            conn.request(
                "POST",
                (parsed.path.rstrip("/") or "") + "/v1/chat/completions",
                body=payload,
                headers={"Authorization": "Bearer " + GATEWAY_KEY, "Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            raw = resp.read()
            # A non-2xx (a text-only VISION_MODEL yields a 400, a wrong
            # key a 401) used to vanish into None — the exact silent trap
            # issue #145 describes. Log it so a misconfigured vision model
            # is diagnosable instead of just producing empty descriptions.
            if resp.status >= 300:
                _log(f"describe: gateway HTTP {resp.status} for model {VISION_MODEL!r}: {raw[:200]!r}")
                result.append(None)
                return
            body = jsonlib.loads(raw)
            result.append(body["choices"][0]["message"]["content"])
        except Exception as exc:  # noqa: BLE001 - best-effort garnish
            # Description must never fail extraction, but a swallowed
            # error should still leave a breadcrumb (#145).
            _log(f"describe: gateway call failed for model {VISION_MODEL!r}: {exc!r}")
            result.append(None)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    worker = threading.Thread(target=_call, daemon=True)
    worker.start()
    end = time.monotonic() + timeout
    while worker.is_alive():
        if (state is not None and state["cancelled"]) or time.monotonic() > end:
            # Closing from here errors the thread's blocked read within
            # a tick — it exits and drops the payload immediately rather
            # than holding ~20MB until the socket timeout.
            try:
                conn.close()
            except Exception:
                pass
            worker.join(1.0)
            return None
        worker.join(0.25)
    return result[0] if result else None


# async on purpose, unlike the OCR handlers: sync handlers share one
# thread pool, and a burst of minutes-long OCR jobs would queue these
# behind them — failing readiness probes and scrapes exactly when the
# service is busiest. On the event loop they answer immediately.
@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# --- Mistral files API surface (#130) -------------------------------
# LibreChat's mistral_ocr strategy uploads the document first
# (POST /files), asks for a "signed URL" (GET /files/{id}/url), posts
# that URL to /ocr, then deletes the file. Our signed URL is simply a
# data: URL of the stored bytes — /ocr already accepts those, so OCR
# needs no store lookup and the airgap posture is untouched (nothing is
# ever fetched over the network).
# Per-POD state: run this service single-replica (the helm chart
# enforces it) or front it with session affinity — a second replica
# would 404 half the signed-URL lookups.
_FILE_STORE: dict[str, tuple[float, str, bytes]] = {}  # id -> (stored_at, mime, bytes)
# The sync upload handler runs in the threadpool while the async
# url/delete handlers run on the event loop — unguarded, a GC iterating
# the dict can race a concurrent mutation (RuntimeError: dictionary
# changed size during iteration) and 500 a chat upload.
_FILE_STORE_LOCK = threading.Lock()
_FILE_TTL_SECONDS = 3600
_FILE_STORE_MAX = 64
# Count alone is not a memory bound: 64 maximum-sized uploads approach
# 1 GiB before signed-URL base64 buffers and active OCR work. Keep retained
# chat uploads within a predictable slice of the chart's 2 GiB pod limit.
_FILE_STORE_MAX_BYTES = int(os.environ.get("OCR_FILE_STORE_MAX_BYTES", str(256 * 1024 * 1024)))
if _FILE_STORE_MAX_BYTES < _FILE_MAX_BYTES:
    raise RuntimeError("OCR_FILE_STORE_MAX_BYTES must be at least 15728640")


def _file_store_gc_locked() -> int:
    now = time.monotonic()
    expired = [k for k, (ts, _, _) in _FILE_STORE.items() if now - ts > _FILE_TTL_SECONDS]
    for k in expired:
        _FILE_STORE.pop(k, None)
    return sum(len(entry[2]) for entry in _FILE_STORE.values())


@app.post("/v1/files")
@app.post("/files")
def mistral_files_upload(file: UploadFile = File(...), purpose: str = Form("ocr")):
    data = file.file.read(_FILE_MAX_BYTES + 1)
    if len(data) > _FILE_MAX_BYTES:
        raise HTTPException(413, f"file exceeds {_FILE_MAX_BYTES} bytes")
    mime = file.content_type or "application/octet-stream"
    if mime == "application/octet-stream" and (file.filename or "").lower().endswith(".pdf"):
        mime = PDF_TYPE
    file_id = uuid.uuid4().hex
    with _FILE_STORE_LOCK:
        stored_bytes = _file_store_gc_locked()
        # Never invalidate a file ID already returned to LibreChat. An
        # oldest-first eviction can remove an upload between POST /files
        # and GET /files/{id}/url while OCR is merely queued. Expired files
        # are reclaimed above; if live files still fill the bounded store,
        # reject this upload and let the caller retry after another request
        # completes its normal DELETE.
        if len(_FILE_STORE) >= _FILE_STORE_MAX or stored_bytes + len(data) > _FILE_STORE_MAX_BYTES:
            raise HTTPException(
                503,
                "OCR file store is at capacity; retry after an active upload completes",
                headers={"Retry-After": "1"},
            )
        _FILE_STORE[file_id] = (time.monotonic(), mime, data)
    return JSONResponse({
        "id": file_id,
        "object": "file",
        "bytes": len(data),
        "filename": file.filename,
        "purpose": purpose,
    })


@app.get("/v1/files/{file_id}/url")
@app.get("/files/{file_id}/url")
async def mistral_files_signed_url(file_id: str, expiry: int = 24):
    # GC on read too: without it the advertised TTL only takes effect
    # when some later upload happens to trigger it.
    with _FILE_STORE_LOCK:
        _file_store_gc_locked()
        entry = _FILE_STORE.get(file_id)
    if entry is None:
        raise HTTPException(404, "file not found or expired")
    _, mime, data = entry
    return {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}


@app.delete("/v1/files/{file_id}")
@app.delete("/files/{file_id}")
async def mistral_files_delete(file_id: str):
    with _FILE_STORE_LOCK:
        _FILE_STORE.pop(file_id, None)
    return {"id": file_id, "object": "file", "deleted": True}


# LibreChat integration (#130): LibreChat's built-in OCR support speaks
# the Mistral OCR API (ocr.strategy: custom_ocr in librechat.yaml, with
# baseURL pointed here). This endpoint accepts that wire format —
# a base64 data URL in `document` — runs the exact same pipeline as
# /process, and answers in the shape LibreChat consumes: pages of
# markdown plus usage info. Auth is not enforced: the service lives on
# an internal-only network and LibreChat is a member.
@app.post("/v1/ocr")
@app.post("/ocr")
async def mistral_compatible_ocr(payload: dict, request: Request):
    document = payload.get("document") or {}
    kind = document.get("type", "")
    raw_url = document.get("document_url") if kind == "document_url" else document.get("image_url")
    # Defensive: some clients nest OpenAI-style {"url": "..."}.
    if isinstance(raw_url, dict):
        raw_url = raw_url.get("url")
    if not isinstance(raw_url, str) or not raw_url:
        raise HTTPException(400, "document.document_url or document.image_url (data URL) is required")
    if raw_url.startswith("data:"):
        header, _, b64 = raw_url.partition(",")
        mime = header[5:].split(";", 1)[0] or "application/octet-stream"
        if not header.lower().endswith(";base64"):
            raise HTTPException(400, "data URL must use base64 encoding")
        if len(b64) > _FILE_MAX_B64_CHARS:
            raise HTTPException(413, f"file exceeds {_FILE_MAX_BYTES} bytes")
        try:
            data = base64.b64decode(b64, validate=True)
        except Exception:
            raise HTTPException(400, "invalid base64 in data URL")
        # Keep the decoded check too: it documents and defends the actual
        # invariant even if accepted base64 forms change later.
        if len(data) > _FILE_MAX_BYTES:
            raise HTTPException(413, f"file exceeds {_FILE_MAX_BYTES} bytes")
    else:
        # Airgap: never fetch a remote URL from here.
        raise HTTPException(400, "only data: URLs are supported (this service has no egress)")

    filename = "document.pdf" if mime == PDF_TYPE else "image"
    upload = UploadFile(file=io.BytesIO(data), filename=filename, headers=Headers({"content-type": mime}))
    t_start = time.monotonic()
    deadline = t_start + MAX_PROCESS_SECONDS
    state = {"cancelled": False, "proc": None}
    # LibreChat's Mistral OCR call carries no per-request describe flag,
    # so this path follows the service-level OCR_DESCRIBE_IMAGES default
    # (was hardcoded off, which made chat-upload image descriptions
    # impossible regardless of config — #145).
    process_task = asyncio.create_task(
        asyncio.to_thread(_process, [upload], DESCRIBE_IMAGES, deadline, state)
    )
    try:
        # LibreChat has no explicit cancellation callback for this API. Poll
        # the ASGI connection instead and feed disconnects into the same state
        # that kills Tesseract/OCRmyPDF and interrupts Docling for /process.
        while not process_task.done():
            if await request.is_disconnected():
                _cancel_state(state)
                break
            await asyncio.sleep(0.25)
        inner = await process_task
        REQUESTS.labels(outcome="success").inc()
    except asyncio.CancelledError:
        # Server/task cancellation is another abandoned caller. Stop the
        # thread's subprocess/Docling work before allowing the handler to go.
        _cancel_state(state)
        try:
            await asyncio.shield(process_task)
        except (Exception, asyncio.CancelledError):
            pass
        raise
    except HTTPException as e:
        REQUESTS.labels(outcome="client_error" if e.status_code < 500 else "server_error").inc()
        raise
    except Exception:
        REQUESTS.labels(outcome="server_error").inc()
        raise
    finally:
        STAGE_DURATION.labels(stage="total").observe(time.monotonic() - t_start)
    result = jsonlib.loads(inner.body)
    markdown = result["markdown"]
    # Fold any vision descriptions into the returned markdown so they
    # actually reach the chat context — they live in a separate field
    # the Mistral response shape has no slot for, so without this they
    # were computed (when enabled) and then dropped (#145).
    descriptions = result.get("descriptions") or []
    if descriptions:
        blocks = "\n\n".join(f"**Image description:** {d}" for d in descriptions)
        markdown = f"{markdown}\n\n{blocks}" if markdown.strip() else blocks
    return JSONResponse({
        # One page entry carrying the whole document's markdown: docling
        # produces document-level markdown, and LibreChat concatenates
        # page markdowns anyway.
        "pages": [{
            "index": 0,
            "markdown": markdown,
            "images": [],
            "dimensions": None,
        }],
        "model": "nexus-ocr",
        "usage_info": {
            "pages_processed": result["meta"]["pages"],
            "doc_size_bytes": len(data),
        },
    })


@app.post("/process/{request_id}/cancel")
async def cancel_process(request_id: str):
    # async on purpose: must stay responsive while the threadpool is
    # busy with the very work being cancelled.
    live_state = None
    with _INFLIGHT_LOCK:
        _inflight_gc_locked()
        state = _INFLIGHT.get(request_id)
        if state is None:
            # Pre-cancel: the /process for this id may still be reading
            # its upload. Remembered (with a GC timestamp) so it aborts
            # at its first check.
            _INFLIGHT[request_id] = {"cancelled": True, "proc": None, "pre": time.monotonic()}
        else:
            live_state = state
    if live_state is not None:
        _cancel_state(live_state)
    return {"cancelled": True}


@app.post("/process")
def process(
    files: list[UploadFile] = File(...),
    describe: bool = False,
    budget_seconds: float | None = None,
    request_id: str | None = None,
):
    # Plain def, not async: FastAPI runs sync handlers in its worker
    # threadpool, so a minutes-long Tesseract/docling pass doesn't
    # monopolize the event loop and starve /healthz and /metrics (which
    # the readiness probe and the scraper depend on mid-OCR).
    #
    # Outcome accounting wraps the real pipeline so every exit path —
    # including validation raises — lands in exactly one outcome bucket.
    t_start = time.monotonic()
    budget = min(budget_seconds, MAX_PROCESS_SECONDS) if budget_seconds and budget_seconds > 0 else MAX_PROCESS_SECONDS
    deadline = t_start + budget
    state = _inflight_register(request_id)
    try:
        response = _process(files, describe, deadline, state)
        REQUESTS.labels(outcome="success").inc()
        return response
    except HTTPException as e:
        REQUESTS.labels(outcome="client_error" if e.status_code < 500 else "server_error").inc()
        raise
    except Exception:
        REQUESTS.labels(outcome="server_error").inc()
        raise
    finally:
        _inflight_unregister(request_id)
        STAGE_DURATION.labels(stage="total").observe(time.monotonic() - t_start)


def _process(
    files: list[UploadFile], describe: bool, deadline: float | None = None, state: dict | None = None
) -> JSONResponse:
    if deadline is None:
        deadline = time.monotonic() + MAX_PROCESS_SECONDS
    _check_cancelled(state)
    if not files:
        raise HTTPException(400, "no files")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        images: list[Path] = []
        pdfs: list[Path] = []
        image_payloads: list[tuple[bytes, str]] = []
        if len(files) > _PROCESS_MAX_FILES:
            raise HTTPException(413, f"request exceeds {_PROCESS_MAX_FILES} files")
        total_input_bytes = 0
        for i, f in enumerate(files):
            remaining_request_bytes = _PROCESS_MAX_TOTAL_BYTES - total_input_bytes
            read_limit = min(_FILE_MAX_BYTES, remaining_request_bytes)
            data = f.file.read(read_limit + 1)
            if len(data) > read_limit:
                if read_limit == _FILE_MAX_BYTES:
                    raise HTTPException(413, f"file exceeds {_FILE_MAX_BYTES} bytes")
                raise HTTPException(413, f"request exceeds {_PROCESS_MAX_TOTAL_BYTES} bytes")
            total_input_bytes += len(data)
            mime = f.content_type or ""
            if mime in IMAGE_TYPES:
                p = tdp / f"img_{i}"
                images.append(_write_img2pdf_input(data, mime, p))
                image_payloads.append((data, mime))
                # image/png -> png, image/jpeg -> jpeg, ... — the concrete
                # type, so operators can see what callers actually send.
                INPUT_FILES.labels(kind=mime.split("/", 1)[1]).inc()
            elif mime == PDF_TYPE or (f.filename or "").lower().endswith(".pdf"):
                p = tdp / f"in_{i}.pdf"
                p.write_bytes(data)
                pdfs.append(p)
                INPUT_FILES.labels(kind="pdf").inc()
            else:
                raise HTTPException(415, f"unsupported type {mime!r} for {f.filename!r}")

        # Multi-image -> one PDF (ocrmypdf converts a single image only;
        # img2pdf is the documented path for several). -s <dpi>dpi:
        # img2pdf's default treats DPI-less images as 96dpi, which would
        # override the 300dpi assumption the whole pipeline documents —
        # ocrmypdf's own --image-dpi is ignored for PDF inputs, so the
        # page geometry set here is the one Tesseract actually sees.
        if images:
            imgpdf = tdp / "images.pdf"
            with STAGE_DURATION.labels(stage="img2pdf").time():
                try:
                    proc_img = _run_tracked(
                        ["img2pdf", "-s", f"{IMAGE_DPI}dpi", *map(str, images), "-o", str(imgpdf)],
                        state,
                        _remaining(deadline, "img2pdf"),
                    )
                except subprocess.TimeoutExpired:
                    raise HTTPException(408, "processing budget exhausted during image-to-PDF conversion")
                if proc_img.returncode != 0:
                    # Malformed/corrupt image: a client error, not a crash.
                    raise HTTPException(422, f"image-to-PDF conversion failed: {(proc_img.stderr or '')[-300:]}")
            pdfs.append(imgpdf)
        if len(pdfs) > 1:
            raise HTTPException(400, "send one document (or one batch of images) per request")
        src = pdfs[0]

        searchable = tdp / "searchable.pdf"
        # --skip-text: pages that already carry text pass through
        # untouched (digital PDFs cost zero OCR); only true scans get
        # the single Tesseract pass.
        with STAGE_DURATION.labels(stage="ocrmypdf").time():
            # timeout kills the whole Tesseract pass — the stage where an
            # abandoned request would otherwise burn CPU the longest.
            try:
                proc = _run_tracked(
                    # --rotate-pages: correct 90/180/270 scans using
                    # Tesseract's OSD (tesseract-ocr-osd) — without it a
                    # rotated upload OCRs to garbage (E2E finding). Needs
                    # the osd traineddata, installed in the image.
                    ["ocrmypdf", "--skip-text", "--rotate-pages", "--image-dpi", IMAGE_DPI, "--output-type", "pdf", str(src), str(searchable)],
                    state,
                    _remaining(deadline, "ocrmypdf"),
                )
            except subprocess.TimeoutExpired:
                raise HTTPException(408, "processing budget exhausted during OCR")
        # Exit 6 (ExitCode.already_done_ocr) means every page already
        # carried text — with --skip-text the current release exits 0
        # for that case (verified live), but older ocrmypdf versions
        # report 6 and write no output. Either way the "searchable" PDF
        # is just the input, unchanged.
        if proc.returncode == 6 and not searchable.exists():
            searchable.write_bytes(src.read_bytes())
        elif proc.returncode != 0:
            raise HTTPException(422, f"ocrmypdf failed ({proc.returncode}): {proc.stderr[-500:]}")
        # ocrmypdf's stderr (verified against 17.x): pages that went
        # through Tesseract are reported as "Parsing N pages with
        # HocrParser"; pages passed through untouched log "skipping all
        # processing on this page".
        ocr_pages = sum(int(n) for n in re.findall(r"Parsing (\d+) pages with HocrParser", proc.stderr))
        skipped_pages = proc.stderr.count("skipping all processing on this page")
        PAGES.labels(disposition="ocred").inc(ocr_pages)
        PAGES.labels(disposition="skipped").inc(skipped_pages)
        # Page count of this document regardless of disposition — a
        # 40-page contract and 40 one-page receipts are different loads
        # that the counters above cannot tell apart.
        DOC_PAGES.observe(ocr_pages + skipped_pages)

        md_out = tdp / "docling.md"
        with STAGE_DURATION.labels(stage="docling").time():
            _docling_convert(searchable, md_out, deadline, state)
        markdown = md_out.read_text(encoding="utf-8")

        # docling's layout model classifies short/strip-geometry pages
        # (screen-density image uploads become ~4in pages at 300dpi) as
        # pictures and emits only "<!-- image -->", discarding the text
        # layer ocrmypdf already produced. When docling yields no
        # extractable text but the searchable PDF does, fall back to that
        # text layer rather than returning an empty extraction (issue
        # found in E2E: PNG/JPEG/rotated/low-res uploads lost all text).
        if not _has_extractable_text(markdown):
            fallback = _extract_pdf_text_layer(searchable)
            if fallback:
                markdown = fallback

        descriptions = []
        if describe:
            with STAGE_DURATION.labels(stage="describe").time():
                for data, mime in image_payloads:
                    # Best-effort garnish: never 408 over descriptions,
                    # but also never let a slow vision gateway hold the
                    # sync handler past the caller's deadline — the
                    # request timeout is capped by what's left of it,
                    # and a cancelled request stops describing at once.
                    if state is not None and state["cancelled"]:
                        break
                    left = deadline - time.monotonic()
                    # Guarantee a description attempt a working budget even
                    # when OCR/docling already consumed most of a tight
                    # caller budget — otherwise the vision model is starved
                    # to a silent "unavailable" (#145). Still bounded above
                    # by the 240s gateway ceiling and by cancellation.
                    budget = max(left, DESCRIBE_MIN_BUDGET_S)
                    d = _describe_image(data, mime, timeout=min(240.0, budget), state=state)
                    if d:
                        descriptions.append(d)
                        DESCRIPTIONS.labels(outcome="returned").inc()
                    else:
                        DESCRIPTIONS.labels(outcome="unavailable").inc()

        return JSONResponse({
            "markdown": markdown,
            "searchable_pdf_base64": base64.b64encode(searchable.read_bytes()).decode(),
            "descriptions": descriptions,
            "meta": {
                "input_files": len(files),
                "pages": ocr_pages + skipped_pages,
                "ocr_reported": ocr_pages,
                "skipped_pages": skipped_pages,
                "ocrmypdf_stderr_tail": proc.stderr[-300:],
            },
        })
