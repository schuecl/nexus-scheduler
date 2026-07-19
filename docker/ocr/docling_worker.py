# Docling conversion as a persistent child process of service.py.
#
# Why a separate process at all: docling runs in-process and cannot be
# interrupted mid-conversion — a request whose client already gave up
# (the worker aborts at its run deadline) would keep burning CPU with
# no one listening, which is exactly the orphaned-work condition the
# ?budget_seconds enforcement exists to prevent. As a child process it
# can simply be killed at the deadline and respawned.
#
# Why persistent rather than per-request: the layout models load once
# here at startup (same cost the old in-process converter paid at
# import) instead of on every request.
#
# Protocol: one JSON object per stdin line {"pdf": path, "out": path};
# converts pdf, writes markdown to out, answers one JSON line
# {"ok": true} or {"ok": false, "error": "..."}. Paths are shared with
# the parent via its per-request TemporaryDirectory.
import json
import os
import sys

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling_core.types.doc.document import ContentLayer

# docling with OCR OFF — the single Tesseract pass belongs to ocrmypdf
# (service.py's pipeline); this must mirror the options service.py
# historically used in-process.
_pipeline = PdfPipelineOptions()
# Baked model weights — never the HF cache, never the network.
_artifacts = os.environ.get("DOCLING_ARTIFACTS_PATH")
if _artifacts:
    _pipeline.artifacts_path = _artifacts
_pipeline.do_ocr = False
_pipeline.do_table_structure = True
_converter = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_pipeline)}
)

# Readiness marker: the parent knows models are loaded and requests can
# be answered (loading takes seconds; a request arriving earlier would
# just wait on this process's stdin loop, which is fine — this line is
# informational).
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        result = _converter.convert(req["pdf"])
        # FURNITURE included on purpose: docling classifies bottom-margin
        # content as page-footer furniture and the default export drops
        # it — measured live, that swallowed an invoice's "Payment
        # terms: Net 30 …" line. For agent input and audit, everything
        # Tesseract read must surface.
        markdown = result.document.export_to_markdown(
            included_content_layers={ContentLayer.BODY, ContentLayer.FURNITURE}
        )
        with open(req["out"], "w", encoding="utf-8") as f:
            f.write(markdown)
        print(json.dumps({"ok": True}), flush=True)
    except Exception as e:  # answer, never die: the parent owns lifecycle
        print(json.dumps({"ok": False, "error": str(e)[:500]}), flush=True)
