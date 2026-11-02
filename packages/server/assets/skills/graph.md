# DevChestra skill: graph

Use when: graph — graph rules and edge handles.

> Validator wins over this text. Run `devchestra skill ops` for the CLI lifecycle.

## 5. Graph rules (apply to the top level and to loop bodies)

- Exactly **one `start`** node and **at least one `end`** node.
- Every node must be reachable from `start` and must be able to reach an `end`.
- The graph must be **acyclic**. There are no back edges; repetition is done with a `loop` node (section 11).
- Edge `from`/`to` are node ids, optionally with one `.handle` (see the table below). Nothing else (no `$`-prefixed or multi-dot endpoints).
- `start` has no inbound edges. `end` has no outbound edges and **at most one inbound edge**.
- Every node other than `join` has **at most one inbound edge**. To merge paths, use a `join` (section 9). A node that receives a gate/decision/approval/loop handle edge must have that edge as its only inbound edge.
- A node may have several outbound edges.
- A node with no active inbound edge at run time is **skipped** (recursively), and a skipped node's value reads as `null`. If more than one `end` ends up active in one run, the run fails with `E_WORKFLOW_INVALID`, so give mutually exclusive branches their own ends and make sure parallel paths converge with a `join` before a single end.

Edge endpoints with handles:

| Source node | `from` form | Meaning |
| --- | --- | --- |
| `start`, `agent`, `shell`, `join`, `foreach` | `nodeId` | plain output |
| `gate` | `gateId.branchId` (required) | the named branch; a plain `gateId` source is invalid |
| `decision` | `decisionId.handle` (required) | `true` / `false` (boolean mode) or your branch/band id, plus `uncertain` in every mode |
| `approval` | `approvalId` or `approvalId.rejected` | approved path / rejected path |
| `loop` | `loopId` or `loopId.exhausted` | condition met / iteration budget exhausted |
| `workflow` | `callId` or `callId.failed` | child succeeded / child failed or was rejected; an unwired failure fails the invocation |

| Target node | `to` form | Meaning |
| --- | --- | --- |
| any node except `join` and `start` | `nodeId` | the node's single input |
| `join` | `joinId.inputName` (required) | one declared input; each input has exactly one inbound edge |

```json fragment
[
  { "id": "to-gate", "from": "check", "to": "route" },
  { "id": "gate-clean", "from": "route.clean", "to": "note" },
  { "id": "approve-no", "from": "confirm.rejected", "to": "declined" },
  { "id": "into-join", "from": "note", "to": "merge.passed" },
  { "id": "loop-spent", "from": "refine.exhausted", "to": "spent" }
]
```

