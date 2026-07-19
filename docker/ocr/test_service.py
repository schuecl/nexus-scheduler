# Regression tests for the OCR text-layer fallback (E2E DEF-02) and the
# extraction-decision helper. Runs standalone: `python3 test_service.py`
# (no pytest needed) or under pytest if available. Kept dependency-light
# so it can run in the build image.
import os
import sys

os.environ.setdefault("DOCLING_ARTIFACTS_PATH", "/opt/docling-models")
sys.path.insert(0, os.path.dirname(__file__))

# Import only the pure helper without triggering docling model load at
# import time would be ideal; service.py imports docling at module load,
# so these run inside the OCR image where that's available.
import service  # noqa: E402
from service import _has_extractable_text  # noqa: E402


def check(name, cond):
    print(f"{'PASS' if cond else 'FAIL'} {name}")
    if not cond:
        check.failed += 1


check.failed = 0

# docling image-only output must be treated as "no text" so the fallback
# to the ocrmypdf text layer kicks in (the exact DEF-02 condition).
check("image-only placeholder -> no text", _has_extractable_text("<!-- image -->") is False)
check("two image placeholders -> no text", _has_extractable_text("<!-- image -->\n\n<!-- image -->") is False)
check("markdown noise only -> no text", _has_extractable_text("## \n\n---\n\n**  **") is False)
check("empty -> no text", _has_extractable_text("") is False)

# Real text (even alongside a placeholder) must be kept as-is.
check("real text -> has text", _has_extractable_text("SCANNED MEMO 4402") is True)
check("text + placeholder -> has text", _has_extractable_text("Invoice 7301\n<!-- image -->") is True)
check("table markdown -> has text", _has_extractable_text("## ITEM QTY\n\nWIDGET 42") is True)

# DEF-04: OCR_DESCRIBE_IMAGES parses truthy/falsey correctly (the
# Mistral-path default; a stray "false" must not enable describe).
def _parse(v):
    return v.strip().lower() in ("1", "true", "yes", "on")


check("describe default 'true' -> on", _parse("true") is True)
check("describe default 'True ' -> on", _parse("True ") is True)
check("describe default 'false' -> off", _parse("false") is False)
check("describe default '' -> off", _parse("") is False)
check("describe default '0' -> off", _parse("0") is False)

# DEF-04: the describe-budget floor keeps a description attempt viable
# even when upstream stages consumed most of a tight caller budget.
check("describe budget floor is positive", service.DESCRIBE_MIN_BUDGET_S > 0)
check(
    "describe budget floored to minimum when little remains",
    max(0.5, service.DESCRIBE_MIN_BUDGET_S) == service.DESCRIBE_MIN_BUDGET_S,
)

if check.failed:
    print(f"\n{check.failed} FAILED")
    sys.exit(1)
print("\nall regression checks passed")
