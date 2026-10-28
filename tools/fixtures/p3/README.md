# P3 acceptance fixtures

Deterministic test-only fake workflows and scripts for `tools/p3-smoke` (require `DEVCHESTRA_ALLOW_FAKE=1`). The primary
AT-3 flow creates a blank workflow through the browser UI; these files support
HTTP/conflict/security cases and keep a known-good four-node graph available
without hand-editing JSON.

| File | Purpose |
|---|---|
| `workflows/p3-linear.json` | Supported start/agent/shell/end graph with `summary` and `points` output. |
| `workflows/p3-incomplete.json` | Structurally valid but semantically incomplete graph for save/reload/fix testing. |
| `scripts/summary.json` | Immediate valid fake-agent submission. |
| `scripts/slow.json` | Six-second fake submission for close/reopen and in-flight race tests. |
| `scripts/raw.json` | Raw JSON-object submission with nested repository records, arrays, null/false/0. |

The automatic handoff script is generated in each test's temp workspace (not a
repository fixture): it uses the test-only fake-agent `submit-from-inputs` step
with a runtime nonce and 14 repository records. No fixture invokes a paid
provider; the fake agent is trusted only through test-only `devchestra start --fake-script` (requires `DEVCHESTRA_ALLOW_FAKE=1`).
