# DevChestra

Conduct your coding agents like an orchestra.

DevChestra is a local workflow builder for headless coding agents. You drag a few boxes on a canvas, hit Run, and watch Claude, Codex, OpenCode, or Pi do the work in order — with branches, loops, and human check-ins where you want them.

![DevChestra workflow editor](docs/images/editor.png)

Above: a real workflow in DevChestra. Start with a parameter, hand it to two agents in sequence, then finish. Runs, transcripts, and replay live in the same window.

## Why it's nice

Chatting with agents is great for one-offs. Real work is rarely one step. Research, then rank. Draft, then review. Write code, run tests, fix what broke.

DevChestra lets you draw that process once and rerun it whenever you want, without babysitting every prompt or pasting output from one chat into the next.

## What you build with

Everything starts from the Add node menu. Ten nodes, that's the whole vocabulary:

![Available nodes](docs/images/nodes.png)

Agent — run an agent step. Pick your CLI and model, write the prompt, done.

Shell — run a command. Tests, linters, scripts, whatever you'd run yourself.

Gate — route by condition. First matching branch wins, otherwise falls through.

Join — merge branches back together. Wait for the first one, or all of them.

Approval — pause for a person. Nothing moves until someone says go.

Decision — ask a decision model when you need a judgment call, not just code.

Loop — repeat until a condition is met. Each round keeps its own history.

For each — process every item in a list, one at a time.

Run workflow — call a reusable workflow and wait for it to finish.

End — finish the run.

That's it. Most workflows are just Start → Agent → Agent → End.

## How a run feels

1. Register your project once by pointing DevChestra at a folder.
2. Draw your workflow. No JSON, the editor saves and validates as you go.
3. Press Run. Pick where it runs — your project folder as-is, an existing worktree, or a fresh worktree per run — then follow along live with events and transcripts.

If two people edit the same workflow, DevChestra catches the conflict instead of silently overwriting.

Agents automatically receive what came before them, so a plain prompt like "sort by total stars, descending" just works. No template syntax required unless you want it.

## Get going

You need Node 22 or newer and pnpm 10.14.0.

```sh
pnpm setup:global
devchestra start
```

That installs everything, links the `devchestra` command, and opens the editor in your browser. Run it again any time something looks off, it's safe to repeat.

Prefer the manual route?

```sh
pnpm install
pnpm build
pnpm devchestra start
```

To run a workflow straight from the terminal:

```sh
pnpm devchestra run examples/linear-codex.json \
  --project . \
  --param topic=devchestra \
  --json
```

Works with the CLIs you already signed in to: Claude Code, Codex, OpenCode, and Pi. DevChestra never asks for their keys, it just uses what's there.

Decision nodes are the one exception — they need their own keys. Copy `.env.example` to `.env` and fill in only the provider you use.

## One more thing

Every registered project gets a `.devchestra/skill.md` file. It's a plain-English guide that tells any coding agent how to write a valid workflow for your project. Point your agent at it and say what you want built.

Local-first, single user, your files stay yours. No cloud account, no queue, no sandbox magic — steps run with your normal permissions in the workspace you chose.
