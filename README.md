<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/images/logo-lockup-light.svg">
    <img alt="DevChestra" src="assets/images/logo-lockup.svg" width="300">
  </picture>
</h1>

Conduct your coding agents like an orchestra.

DevChestra is a local workflow builder for headless coding agents. Draw a workflow on the canvas or have your coding agent create one through the CLI, then watch Claude, Codex, OpenCode, or Pi do the work — with branches, loops, and human check-ins where you want them.

It's not another agent to babysit. It's the stage your agents play on.

![DevChestra workflow editor](assets/images/workflow-router.png)

Above: a real DevChestra workflow that routes a PR review by risk, with a separate follow-up path. Runs, transcripts, and replay live in the same window.

## Why it's nice

Pasting the same instructions into chat every time and hoping the agent does it the same way? That's the problem. Chat is vibes: same prompt, different tools, different order, different day.

DevChestra makes the boring parts deterministic. You build the process once — who runs, what tools and MCPs they get, what they're allowed to touch, what they must hand back, what happens next — and it runs that way every time. The agents still improvise inside their box (they're LLMs, after all), but the orchestration around them doesn't.

Research, then rank. Draft, then review. Write code, run tests, fix what broke. No babysitting prompts, no pasting output from one chat into the next.

## What can you build?

We built a PR review workflow that routes changes by risk and sends follow-up work down its own path. That's one way to put the pieces together. A few others:

- **Bug triage to PR** — reproduce the issue, investigate, implement a fix, run tests, and ask for a review before opening a PR.
- **Ticket to PR** — turn a Linear or GitHub ticket into a plan, implementation, tests, and a PR, with a human check-in along the way.
- **User flow testing** — walk through a product flow, check the UI, capture what broke, and send failures back for a fix and another test.
- **Lead research** — find potential leads, check them against your criteria, and hand a structured list to a person for review.
- **Content pipeline** — research a topic, draft, edit, check against a brief, and get approval before publishing.

The workflow decides the order, handoffs, branches, and review points. The agents do the work inside each step, using the tools and access you give them.

## What you build with

The canvas and CLI use the same workflow vocabulary:

![Available nodes](assets/images/nodes.png)

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

## How a run feels

1. Register your project once by pointing DevChestra at a folder. A new project comes with two starter workflows, "Tour this project" (read-only survey) and "Fix failing tests" (test, fix, retest, ask for approval), using the first coding CLI it finds. Pass `--no-starters` to `devchestra project add` to skip them.
2. Build a workflow on the canvas, or ask your coding agent to create and validate one through the CLI.
3. Start a run in the editor or from the CLI. Pick where it runs — your project folder as-is, an existing worktree, or a fresh worktree per run.
4. Follow events and transcripts in the editor, or let your agent watch the run, inspect errors and usage, and bring human review gates back to you through the CLI.

The CLI speaks JSON, so an agent can start a run, check its status, and reconnect to watch it without keeping the editor open. If two people edit the same workflow, DevChestra catches the conflict instead of silently overwriting.

Agents automatically receive what came before them, so a plain prompt like "sort by total stars, descending" just works. No template syntax required unless you want it.


## Get going

The easiest what to get set up is ask your codling agent to set it up for you
```
set up https://github.com/Pranav-Official/Dev-Chestra globaly
# if you are working on a project then...
Also register this project as well.
```

You need Node 22 or newer and npm 11 or newer (ships with Node 24; on Node 22 run `npm install -g npm@latest` once). pnpm 10.14.0 or newer also works if you prefer it — the setup script uses whichever manager invoked it, defaulting to pnpm when both are installed.

```sh
npm run setup:global
devchestra start
```

That installs everything, links the `devchestra` command, and opens the editor in your browser. Run it again any time something looks off, it's safe to repeat. Prefer pnpm? Run `pnpm setup:global` (or `npm run setup:global -- --pm=pnpm`) instead.

Prefer the manual route?

```sh
npm install
npm run build
npm run devchestra:start
```

Prefer to work through your coding agent? Start DevChestra without the browser:

```sh
devchestra start --headless
```

Agents can also refer skills by using 
```
devchestra skill
```

Agents can use it to create, validate, run, and monitor workflows. Then ask it something like "build a workflow that runs the linter, then asks me before fixing anything." It can use the CLI to manage the workflow and follow a run when you ask it to start one.

You can use the same commands yourself. Here, `workflow.json` contains a workflow with the ID `my-workflow`:

```sh
devchestra project add /path/to/project
devchestra workflow create --project /path/to/project --file workflow.json
devchestra run start my-workflow --project /path/to/project
devchestra run watch <run-id> --jsonl
```

See the [CLI guide](packages/cli/README.md) for validation, approvals, recovery, and the rest of the commands.

Works with the CLIs you already signed in to: Claude Code, Codex, OpenCode, and Pi. DevChestra never asks for their keys, it just uses what's there.

Decision nodes are the one exception — they need their own keys. Copy `.env.example` to `.env` and fill in only the provider you use.

## It lives where you already work

Use the canvas when you want to see the whole process. Use the CLI when you're working with an agent in your terminal or IDE. Either way, workflows live in your project, ready to rerun, share, and version like code.

Local-first, single user, your files stay yours. No cloud account, no queue, no sandbox magic — steps run with your normal permissions in the workspace you chose.

## Third-party icons

The monochrome provider icons are vendored from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT, Copyright (c) 2023 LobeHub) and the official Pi mark from pi.dev. The marks belong to their respective owners and are used only to identify the matching CLI.
