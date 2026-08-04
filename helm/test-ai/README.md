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

### Fix: point at your own MongoDB

Set `mongo.external.existingSecret` to a Secret name (key `uri`,
holding a full connection string) and the chart renders **no** `mongo`
StatefulSet, Service, PVC, or NetworkPolicy — LibreChat's `MONGO_URI`
comes from that Secret instead. Use this to point at a FIPS-capable
MongoDB (e.g. [Percona Server for
MongoDB](https://www.percona.com/mongodb/software/percona-server-for-mongodb),
which builds against a FIPS-validated OpenSSL module) or any MongoDB
you already run:

```bash
kubectl -n <namespace> create secret generic my-mongo \
  --from-literal=uri='mongodb://user:pass@my-mongo-host:27017/LibreChat'
```

```yaml
mongo:
  external:
    existingSecret: my-mongo
```

There is no bundled FIPS-capable image option — this Secret-based
external URI is the supported fix (#251). A different default image
(swapping `mongo:8.0.20` for one with a validated FIPS module) was
also discussed in #194 but needs a licence/compatibility review and
isn't implemented.

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
