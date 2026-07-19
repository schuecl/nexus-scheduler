# OCR + document-understanding service (#109). Everything is baked into
# the image at build time — Tesseract language data, docling's layout/
# table models, all Python packages — because the airgap rule is that
# nothing may be fetched at runtime. Build once with egress, run forever
# without.
#
# Engine roster and why (see #109 for the full evaluation):
#   docling      MIT           layout, tables, reading order; OCR engine
#                              pinned to Tesseract IN CODE — its default
#                              (EasyOCR) silently downloads weights at
#                              first use, which is fatal airgapped
#   ocrmypdf     MPL-2.0       the single OCR pass; produces the
#                              searchable-PDF audit artifact
#   tesseract    Apache-2.0    the one recognition engine, shared
#   tessdata     Apache-2.0    language data, baked in via apt
#   pypdfium2    BSD-3-Clause  rasterization (no Ghostscript, no AGPL)
#   img2pdf      LGPL-3.0      multi-image inputs -> one PDF
# Digest-pinned base: an approved offline artifact must be rebuildable
# from exactly the reviewed inputs, not whatever the tag points at today.
FROM python:3.12-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b

# Ghostscript is deliberately ABSENT although OCRmyPDF's docs list it
# as a requirement: every gs-dependent path is pinned off (the service
# always runs --output-type pdf, never pdfa) and the whole offline
# battery passes without it — while including it would put AGPL in the
# image, which #109's roster excludes. A PDF that genuinely needs gs
# rasterization fails as a clean 422, which the worker treats as
# non-retryable.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng \
      tesseract-ocr-osd \
      img2pdf \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# docling pulls torch; keep it CPU-only so the image stays mirrorable at
# sane size and runs identically on any host. Torch is installed FIRST,
# alone, from the CPU index — in a combined install pip arbitrates
# between PyPI and the extra index and can pick the CUDA build from
# PyPI on amd64. All versions pinned: the reviewed airgap artifact must
# resolve identically on every rebuild.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
      "torch==2.13.0" "torchvision==0.28.0"
RUN pip install --no-cache-dir \
      "docling==2.113.0" "ocrmypdf==17.8.1" "pypdfium2==5.12.1" \
      "Pillow==12.2.0" \
      "fastapi==0.139.2" "uvicorn[standard]==0.51.0" "python-multipart==0.0.32" \
      "prometheus-client==0.25.0"

# Bake docling's layout/table model weights into the image (they are
# otherwise downloaded on first use — the same silent-egress trap as
# EasyOCR, from a different direction). HF_HOME must be set BEFORE the
# download and readable by the runtime user: the offline acceptance
# test caught the default (root's ~/.cache) being invisible to
# USER nobody, which surfaced as a runtime download attempt — exactly
# the failure the airgap check exists to find.
# Explicit artifacts directory, wired to the pipeline via
# DOCLING_ARTIFACTS_PATH — the HF-cache route left refs without
# snapshots (downloader materializes to an output dir), which the
# offline test caught as a runtime download attempt. with_rapidocr is
# ON by default and is a PaddleOCR port — excluded per #109's origin
# policy; Tesseract is the only recognition engine in this image.
RUN python -c "from docling.utils.model_downloader import download_models; from pathlib import Path; download_models(output_dir=Path('/opt/docling-models'), with_rapidocr=False)" \
    && chmod -R a+rX /opt/docling-models
ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models

COPY service.py /app/service.py
COPY docling_worker.py /app/docling_worker.py
WORKDIR /app

# Runtime proof of the no-egress claim: the service never needs the
# network for anything but its own HTTP listener.
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
EXPOSE 4200
# Numeric (= nobody) so Kubernetes' runAsNonRoot check can verify it;
# with the symbolic name the kubelet rejects the container outright.
USER 65534:65534
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "4200"]
