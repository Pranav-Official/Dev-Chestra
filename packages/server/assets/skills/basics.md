# DevChestra skill: basics

Use when: basics — file layout, ids, minimal workflow. Start here for any new workflow.

> Validator wins over this text. Run `devchestra skill ops` for the CLI lifecycle.

## 1. Scope and hard rules

- A workflow is **one JSON file**: `.devchestra/workflows/<id>.json`, where `<id>` equals the `id` field inside the file.
- Do **not** run the workflow unless the user explicitly asked you to run it. Real agent nodes use the user's signed-in CLI accounts, can cost money, and can edit project files.
- Do not invent CLI subcommands, flags, node fields or node types. Use `devchestra skill ops` for the CLI lifecycle and `devchestra skill triggers` for `start.polling` / `start.webhook`.
- Unknown keys are rejected everywhere (the parser is strict). Nodes have **no** `description` field; only the workflow itself does.
- JSON only: no comments, no trailing commas. Use 2-space indentation and end the file with a newline.
- The file must be at most 1 MiB.

## 2. File, ids and naming

| Thing | Rule |
| --- | --- |
| Workflow file | `.devchestra/workflows/<id>.json` |
| Workflow `id` | `^[a-z0-9-]{1,64}$` (lowercase letters, digits, hyphen) and must equal the file name without `.json` |
| Workflow `name` | non-empty, at most 200 characters |
| `schemaVersion` | exactly `1` |
| Node `id` | `^[a-z][a-z0-9_]{0,47}$` (starts with a letter; letters, digits, underscore; **no hyphens**). Node ids are names in expressions, so avoid JSONata words such as `and`, `or`, `in`, `true`, `false`, `null`. |
| Node `name` | non-empty, at most 200 characters (shown in the UI) |
| Reserved node ids | `start` is reserved for the start node. Inside a loop body, `loop` and `result` are also reserved; inside a foreach body, `foreach` and `result` are also reserved. Node ids must be unique within their graph. |
| Edge `id` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, unique |
| Handle names (gate branch ids, join input names, decision branch/band ids) | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` |
| Start parameter `name` | `^[A-Za-z_][A-Za-z0-9_]{0,63}$` (no hyphens) |

Choose a short, descriptive, hyphenated workflow id (`fix-lint-errors`, `release-notes`). If the user asked for a name, derive the id from it. Do not reuse an existing file's id unless you were asked to edit that workflow.

Add `"ui": { "x": <number>, "y": <number> }` to every node (including loop body nodes). It is editor layout only, and without it the editor stacks all nodes at the origin. Lay nodes out left to right about 260 px apart and about 140 px apart vertically for parallel branches. Edges need no `ui`.

## 3. Top-level shape

```json fragment
{
  "schemaVersion": 1,
  "id": "my-workflow",
  "name": "My workflow",
  "description": "Optional one-line description.",
  "graph": { "nodes": [], "edges": [] }
}
```

`budget` and `supervisor` are **not supported** (they are rejected if present). Do not add them.

## 4. A complete minimal runnable workflow

Start with one input, one agent, one end. This validates and is runnable as written:

```json
{
  "schemaVersion": 1,
  "id": "summarize-topic",
  "name": "Summarize a topic",
  "description": "Ask one agent for a short summary of a topic.",
  "graph": {
    "nodes": [
      {
        "id": "start",
        "type": "start",
        "name": "Start",
        "ui": { "x": 80, "y": 160 },
        "params": [{ "name": "topic", "type": "string", "required": true }]
      },
      {
        "id": "summarize",
        "type": "agent",
        "name": "Summarize",
        "ui": { "x": 340, "y": 160 },
        "cli": "claude-code",
        "prompt": "Write a three-sentence summary of: {{ start.topic }}",
        "output": {
          "type": "object",
          "properties": { "summary": { "type": "string" } },
          "required": ["summary"],
          "additionalProperties": false
        },
        "permissions": { "network": false, "write": [] }
      },
      {
        "id": "end",
        "type": "end",
        "name": "End",
        "ui": { "x": 600, "y": 160 },
        "status": "success",
        "result": "{\"summary\": summarize.summary}"
      }
    ],
    "edges": [
      { "id": "e1", "from": "start", "to": "summarize" },
      { "id": "e2", "from": "summarize", "to": "end" }
    ]
  }
}
```

