# DevChestra skill: expressions

Use when: expressions — params, outputs, JSONata templates vs bare expressions, scope.

> Validator wins over this text. Run `devchestra skill ops` for the CLI lifecycle.

## 6. Data flow: params, outputs and references

A node's output is stored under its **node id**; run parameters are under `start`.

| Node | Output other nodes can read |
| --- | --- |
| `start` | the run parameters, e.g. `start.topic` |
| `agent` | the validated object the agent submitted (matches its `output` schema) |
| `shell` | `{ "exitCode", "signal", "stdout", "stderr", "durationMs" }` (stdout/stderr are the last 64 KiB each) |
| `gate` | `{ "branch": "<id of the taken branch>" }` |
| `join` | mode `first`: the active input's value. Mode `all`: an object keyed by input name, with `null` for inputs that did not run |
| `approval` | `{ "decision": "approve" \| "reject", "by": ..., "note"?: ..., "requestId": ... }` |
| `decision` | the provider answer object, including `value`, `kind` and `confidence` (an unknown confidence reads as `0`) |
| `loop` | the envelope `{ "result": ..., "iterations": N, "outcome": "condition_met" \| "iteration_limit" }` |
| `foreach` | `{ "total", "processed", "succeeded", "failed", "rejected", "resultsRef" }`; item values are stored separately, not returned as an array |
| `workflow` | `{ "childRunId", "status", "result" }`; `result` is the child's successful End result, or `null` on failure/rejection |
| `end` | the run result (read by a parent `workflow` call when invoked as a child) |

### Two syntaxes: templates versus bare expressions

DevChestra uses [JSONata](https://jsonata.org) expressions in two forms:

| Form | Used in | Example |
| --- | --- | --- |
| **Template**: free text with `{{ expression }}` placeholders | agent `prompt`, shell `command`, approval `message`, decision `state`, foreach CSV `source.path` | `"Summarize {{ start.topic }} for {{ start.audience }}"` |
| **Bare expression**: the whole field is one expression | gate branch `when`, end `result`, loop `initialState`, `nextState`, `result`, `until`, foreach array `source.expression` and `result`, each workflow `inputs` value | `"check.exitCode = 0"` |

- Do **not** put `{{ }}` in a bare-expression field, and do not omit it in a template field.
- Write a literal `{{` in a template as `\{{`. The raw form `{{{ ... }}}` is rejected.
- A template placeholder that resolves to `null`/missing inserts an empty string (the run records a warning). Strings are inserted as-is; objects and arrays are inserted as canonical JSON.
- `end.result` must evaluate to something JSON-representable; to return an object, write a JSONata object constructor as a string: `"{\"summary\": summarize.summary}"`.
- Expression limits: source at most 4 KiB, each evaluation at most 250 ms (gates: 2 s overall), result at most 64 KiB.
- Only deterministic built-ins are allowed: `$abs $append $assert $average $base64decode $base64encode $boolean $ceil $clone $contains $count $decodeUrl $decodeUrlComponent $distinct $each $encodeUrl $encodeUrlComponent $error $exists $filter $floor $formatBase $formatInteger $formatNumber $join $keys $length $lookup $lowercase $map $match $max $merge $min $not $number $pad $parseInteger $power $reduce $replace $reverse $round $sift $single $sort $split $spread $sqrt $string $substring $substringAfter $substringBefore $sum $toMillis $trim $type $uppercase $zip`. Variable binding (`$x := ...`), lambdas (`function`), `~>`/dynamic calls, the transform operator, and `$now $millis $random $uuid $eval $env $shuffle $fromMillis` are rejected.

### What a node may reference (ancestors only)

An expression or template can use as roots only `start` and the **ancestors** of the node (nodes that have a directed path to it). Anything else is a validation error `E_EXPR_SCOPE`, even if that node exists elsewhere in the workflow. If a node needs another node's output, **wire the dependency with an edge** so it becomes an ancestor; do not try to read a sibling or downstream node.

At run time an ancestor that was skipped (an untaken gate branch), failed or was cancelled reads as `null`. An agent also automatically receives a labelled JSON block with the run parameters and every accepted ancestor output, so a plain prompt is enough to hand data to a connected agent; `{{ }}` references are optional but are the way to put one specific value in the right place.

The editor's variable picker lists values from the whole workflow for discovery, but it inserts only values that are in scope for that field. The validator is the same: discovery is global, access is ancestors-only.

### Missing values and conditions (JSONata semantics that bite)

These were checked against the real evaluator:

- `x.y = true`, `x.y = 0` and `x.y != 'a'` are all `false` when `x` is `null` or `y` is missing. Note that `!=` on a missing value is `false`, not `true`.
- `x.y > 3` and `x.y < 3` on a missing value are **undefined, not boolean**. A gate branch or a loop `until` returning a non-boolean **fails** (`E_EXPR`) and never falls through to `otherwise`. Guard comparisons: `$exists(x.y) and x.y > 3`.
- Join mode `all` stores `null` for inputs that did not run, so guard before reading: `$exists(merge.fast) and merge.fast.ok = true`.
- A missing field inside an object constructor drops the key: `{"a": x.y}` is `{}` when `x.y` is missing, which can then fail the required properties of a loop `output` schema.

### Large data: pass paths, not contents

Outputs are capped (see section 12) and every output is stored and scanned. For anything bulky (a diff, a log, a generated document), have the producing agent or shell step **write a file in the run workspace** and return its **path** in a result field; the consumer reads the file. Do not return file contents in `output`, and do not interpolate large `stdout` into prompts. DevChestra's own instruction to agents is: files produced for later steps must be referenced by path in the matching result field.

