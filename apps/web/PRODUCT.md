# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Individual developers who already use coding agents and want to turn repeatable work into workflows. They coordinate tasks such as implementing changes, running tests, reviewing results, and requesting approval at chosen points.

## Product Purpose

DevChestra is a local workflow builder for headless coding agents. It lets developers draw, run, and inspect repeatable processes instead of repeatedly coordinating agents by hand.

## Positioning

DevChestra orchestrates coding-agent tools developers already use. Its visual editor makes the process inspectable and repeatable while agents perform work within the steps.

## Operating Context

The product is local-first and single-user. Developers register a project folder, build and validate a workflow, choose a project folder or worktree for a run, and follow events and transcripts in the browser. Steps run with the user's normal permissions in the selected workspace.

## Capabilities and Constraints

- Workflows can combine agent and shell steps with conditions, joins, approvals, decisions, loops, iteration, and reusable workflows.
- Supported agent CLIs include Claude Code, Codex, OpenCode, and Pi, using existing CLI sign-in. Decision nodes use separate provider keys.
- The product does not require a cloud account. Workflow definitions can be shared and versioned as code.

## Brand Commitments

The product is named DevChestra. Its established language describes conducting coding agents like an orchestra.

## Evidence on Hand

The repository README documents the product and includes screenshots of the workflow editor and available nodes. Example workflows are in `examples/`.

## Product Principles

- Make repeatable agent work inspectable and easy to coordinate.
- Keep developers in control of the workflow and approval points.
- Work locally with existing tools and familiar project files.
- Make run progress and history understandable.
