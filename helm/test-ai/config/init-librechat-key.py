# One-shot provisioner (litellm-init Compose service): ensures the
# dedicated virtual key LibreChat uses against the gateway exists.
# LibreChat deliberately does NOT get the master key — the master key
# is LiteLLM's admin credential, and per-key spend, max_budget and
# RPM/TPM limits are enforced on virtual keys, so this key is the
# enforcement point (attach limits to it via /key/update or the admin
# UI at :4000/ui). Safe to re-run: no-ops if the key already exists.
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# Overridable for environments where the gateway is not literally
# "litellm" (the Helm chart uses release-scoped service names).
BASE = os.environ.get("LITELLM_URL", "http://litellm:4000")
MASTER = os.environ["LITELLM_MASTER_KEY"]
LIBRECHAT_KEY = os.environ["LITELLM_LIBRECHAT_KEY"]


def call(path, payload=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Authorization": "Bearer " + MASTER,
            "Content-Type": "application/json",
        },
    )
    return urllib.request.urlopen(req, timeout=15)


try:
    # quote(): a key containing URL-reserved characters (+ & # %) would
    # otherwise change meaning in the query string and break idempotence.
    resp = json.load(call("/key/info?key=" + urllib.parse.quote(LIBRECHAT_KEY, safe="")))
    # A key provisioned before key_type existed here is default-type —
    # it can reach LiteLLM's management routes, which the master-key
    # separation exists to prevent. Migrate it in place rather than
    # treating it as compliant.
    routes = (resp.get("info") or {}).get("allowed_routes") or []
    if routes == ["llm_api_routes"]:
        print("librechat virtual key already exists (llm_api-only) — nothing to do")
        sys.exit(0)
    call(
        "/key/update",
        {"key": LIBRECHAT_KEY, "allowed_routes": ["llm_api_routes"]},
    )
    print("librechat virtual key existed with management access — restricted to llm_api routes")
    sys.exit(0)
except urllib.error.HTTPError as e:
    # LiteLLM answers 4xx for an unknown key; anything else is a real
    # failure worth surfacing.
    if e.code >= 500:
        raise

call(
    "/key/generate",
    {
        "key": LIBRECHAT_KEY,
        "key_alias": "librechat",
        "user_id": "librechat",
        # LLM-only: a default-type key can also reach LiteLLM's
        # management routes (BerriAI/litellm#19492), which would hand
        # LibreChat gateway-admin ability the master-key separation
        # exists to prevent.
        "key_type": "llm_api",
    },
)
print("created the librechat virtual key (alias: librechat, llm_api-only)")
