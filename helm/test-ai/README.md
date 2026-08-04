# helm/test-ai — the AI plane chart

LibreChat, LiteLLM, Ollama and their databases (Postgres for LiteLLM,
MongoDB for LibreChat), as the independent AI-backend install described
in `Chart.yaml`. This page covers one constraint that isn't visible
from the chart itself: **the bundled MongoDB cannot start on a
FIPS-enabled host** (issue #194).

## FIPS-enabled hosts: bundled MongoDB will not start

On a node with `/proc/sys/crypto/fips_enabled == 1`, the `mongo`
StatefulSet crash-loops during startup with:

```
"s":"F", "c":"ASSERT", "id":23089, "msg":"Fatal assertion",
"attr":{"msgid":40379,"file":"src/mongo/crypto/sha_block_openssl.cpp","line":162}
```

LibreChat then fails behind it with `connect ECONNREFUSED
…:27017`. Check before installing:

```bash
cat /proc/sys/crypto/fips_enabled   # on a node this chart will schedule onto
```

**Mechanism** (root-caused in #194): this is not MongoDB using a
non-FIPS-approved algorithm. Containers share the host kernel, and the
stock `mongo:8.0.20` image's Ubuntu-based OpenSSL 3 reads that flag
directly and switches into FIPS mode — but the image ships no FIPS
provider, so *no* digest can load, including SHA-256, which is
FIPS-approved. MongoDB aborts on the first digest it needs. Any
container built on a plain Ubuntu/OpenSSL-3 base with no FIPS module
fails the same way on a FIPS host; it is a base-image property, not a
MongoDB-specific one.

**Not affected**, confirmed on the same FIPS-enabled host: LiteLLM and
its Postgres both come up `1/1 Running` — only the `mongo` StatefulSet
fails. `helm/nexus-scheduler` (the application itself) is FIPS-clean as
of #106. `helm/ocr` has no MongoDB. `helm/observability` (Mimir, Loki,
Grafana, Alloy) starts normally.

**There is no supported fix in this chart yet.** A FIPS-capable image
(e.g. Percona Server for MongoDB) or a `mongo.external.uri` value to
point at a MongoDB you already run are tracked as follow-up work in
#251; neither is implemented. If your target nodes are FIPS-enabled,
this chart's bundled MongoDB (and so LibreChat) cannot be installed
there today.

**Local test clusters only — never production:** on a personal
FIPS-enabled workstation, bind-mounting a file containing `0` over
`/proc/sys/crypto/fips_enabled` inside the `mongo` container makes the
image's OpenSSL fall back out of FIPS mode and start normally (verified
in #194 with plain `docker run`, both directions; reproduced again in
review of #250, including the resulting `mongod` fatal assertion when
the flag is forced the other way). This is a compliance-defeating
workaround, not a fix: it disables the exact control the host turned
on. Only reach for it to unblock local chart development on a machine
that isn't a FIPS-mandated deployment target; never use it to bring
MongoDB up on a host where FIPS is actually required.
