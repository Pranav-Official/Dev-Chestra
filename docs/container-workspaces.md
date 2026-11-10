# Container run workspaces

Container is a run-level workspace option alongside the project folder and Git worktrees. It currently supports **Linux with a local Docker or rootless Podman runtime**. Every agent node, shell node, and gateway policy command in the run executes in a container. Child workflows share the parent run's clone. Decision-provider requests and orchestration remain host services.

## Set up

```sh
devchestra sandbox build
devchestra doctor
devchestra sandbox login codex
# Other dedicated logins:
devchestra sandbox login claude
devchestra sandbox login opencode
devchestra sandbox login pi
```

Use each CLI's interactive login flow inside the container. Codex uses device authentication; Pi supports its interactive `/login`. API-key environment variables supported by the provider's existing allowlist also work. These commands never mount host CLI configuration. Claude's browser-based flow may require opening its printed URL manually; an API key or `CLAUDE_CODE_OAUTH_TOKEN` is another option.

Select **Container** in the Run dialog, or:

```sh
devchestra run workflow.json --project /absolute/project --workspace container
# The API start request accepts:
# { "workspace": { "mode": "container", "includeUncommitted": true }, ... }
```

Podman is preferred when usable; Docker is the fallback. Override with `DEVCHESTRA_CONTAINER_RUNTIME=podman|docker`. Choose a project-specific image by setting `DEVCHESTRA_CONTAINER_IMAGE` when launching that project's server or CLI run. Runtime endpoint, UID/GID and image ID are frozen for resume; changing an image tag does not update an existing run. Remote runtimes are rejected. Docker uses its selected local Unix socket explicitly; Podman validates its local storage identity.

The standard image contains Node/npm, Git, ripgrep, gh, and pinned Claude Code, Codex, OpenCode and Pi versions. For other toolchains or preinstalled dependencies:

```sh
DEVCHESTRA_CONTAINER_IMAGE=localhost/my-project:1 \
  devchestra sandbox build --file ./Containerfile --context .
DEVCHESTRA_CONTAINER_IMAGE=localhost/my-project:1 devchestra start
```

Install dependencies in the image or in a shell node; files installed in the clone persist between nodes. Host-built dependencies are not copied. A custom image must retain Node, the selected CLIs, Git, `/bin/sh`, `/bin/chown`, and a writable `/home/devchestra`. The bundled MCP shim is mounted read-only from the installed DevChestra version.

## Code and results

A standalone clone is stored at `DATA_DIR/projects/PROJECT_ID/runs/RUN_ID/clone`. It has its own Git object store, starts at committed HEAD, and is mounted at the same absolute path. The host repository and its `.git` directory are never mounted. Origin becomes the project's HTTPS remote; common Git SSH URL forms are rewritten to HTTPS. Embedded URL credentials and non-HTTPS origins are rejected. Commit identity is copied; signing configuration is not.

The optional tracked-change import uses a binary Git patch. It includes staged and unstaged tracked changes, but excludes untracked and ignored files and does not preserve their staging state. Submodule checkout and Git LFS materialization are not automatic; configure these explicitly in a workflow if needed.

After node finalization, committed history is fetched to `devchestra/run-RUN_ID` in the project. The working checkout stays unchanged. Fetches do not force-replace a divergent branch. **Agents must commit changes for them to reach that branch.** Uncommitted and untracked results remain in the clone, including after failure/cancellation. The clone is retained for inspection and resume.

When finished, stop the DevChestra server and clean up explicitly:

```sh
devchestra sandbox clean --project /absolute/project --project-id PROJECT_ID --run-id RUN_ID
# Add --force only to discard uncommitted results.
```

Cleanup holds the data-directory lock and refuses a dirty clone by default. It retains the fetched branch and login volumes. A cleaned or replaced clone cannot be resumed.

## Credentials and publishing

Each CLI has one dedicated home volume per DevChestra data directory, covering credentials and session databases. The volumes live in the host runtime's storage; they are not encrypted by DevChestra. They do not reuse host logins. Pi refreshes are serialized through a host lock shared by runs using that volume. Never mount a host live OpenCode database.

Shell nodes have no agent credential volume. Gateway policy commands run in sibling containers without agent/provider/forge credentials or the gateway socket. A node receives a GitHub credential only if it declares `credentials: ["github"]` (also available as a node inspector checkbox). Other credential kinds are rejected.

Configure a single-repository token with Contents and Pull requests write permissions:

```sh
# Pipe a token from a trusted source; do not place it in command arguments.
trusted-secret-command | devchestra sandbox login github --project /absolute/project --stdin
# Explicit alternative: reuse the broader token of an existing host gh account.
devchestra sandbox login github --project /absolute/project --account ACCOUNT
```

Project credential records are private 0600 files under `DATA_DIR/sandbox/credentials`, outside container mounts. A pasted token is stored there in plaintext; host-account records store the account name and resolve its token at launch. The credential helper is supplied using Git environment configuration and `gh auth git-credential`; `GH_TOKEN` alone does not configure Git authentication.

Prefer an agent → approval → publishing shell sequence. For one PR at the end, publish from the host instead, so no forge token enters a container:

```sh
devchestra sandbox publish --project /absolute/project --run-id RUN_ID --base main
```

This pushes the fetched branch and invokes the host's `gh pr create --fill`. It is an explicit publishing action and uses the host's Git/gh authentication. It does not create a commit for dirty clone files.

## Execution boundary and limitations

Containers use `--init`, an unprivileged UID, dropped capabilities, no-new-privileges, and fixed limits of 512 processes, 4 GiB memory and 4 CPUs. Shared bind mounts use shared SELinux labels. Runtime sockets are never mounted. Invocations use private 0600 env-files outside execution mounts, avoiding secrets in runtime argv and host runtime configuration injection. Files are removed on completion or boot recovery. Runtime administrators can still inspect container environments and volumes.

Agent nodes currently require `permissions.network: true`; model-aware egress filtering is not implemented. Unsupported network restrictions fail explicitly. Policy siblings can use `--network=none`, since they do not call model APIs. Network-enabled containers can reach external services and are not an egress sandbox.

Codex uses the container as its outer sandbox; the clone mount is read-only for agents with an empty write permission list. Native shell permissions remain adapter/tool policies. File-reading tools or the agent process itself can access that agent's own credentials. Sibling execution does **not** make tokens inaccessible to the agent, and scripts left in a shared clone can affect later credential-bearing nodes. Proxy-held credentials are not implemented.

Container-owned MCP configuration is scoped per invocation: Claude uses strict MCP configuration, Pi uses its isolated MCP home, Codex lists the container home’s configured servers and explicitly disables unselected ones, and OpenCode uses an isolated config directory with project config discovery disabled. Host-selected extra MCP definitions must use commands/paths available in the image; arbitrary host paths are not mounted.

Cancellation removes the actual container, not just the runtime client. A host registry is written before launch, and boot recovery checks ownership labels before removing leftovers. Clone identity and runtime bindings are checked on resume; lost state is not silently recreated. Rootless Podman has live integration coverage; native Docker needs validation on a machine with a Docker daemon (this development machine's `docker` command is a Podman compatibility frontend). Interactive account logins and real model session resume depend on the respective service and are not exercised by offline tests.

## Validation

```sh
pnpm run typecheck
pnpm test
DEVCHESTRA_TEST_CONTAINER=1 node scripts/workspaces.mjs exec @devchestra/adapters -- vitest run test/container-live.test.ts
DEVCHESTRA_TEST_CONTAINER=1 node scripts/workspaces.mjs exec @devchestra/cli -- vitest run test/container-gateway.test.ts
DEVCHESTRA_TEST_CONTAINER=1 node scripts/workspaces.mjs exec @devchestra/e2e-workflows -- vitest run test/container-workspace.test.ts
node scripts/workspaces.mjs exec @devchestra/e2e-workflows -- vitest run --config vitest.e2e.config.ts test/e2e/container-workspace.browser.test.ts
```

Provider behavior references: [Codex security](https://learn.chatgpt.com/docs/agent-approvals-security), [OpenCode configuration](https://opencode.ai/docs/config/), [Podman mounts and user namespaces](https://docs.podman.io/en/latest/markdown/podman-run.1.html), [GitHub credential helper](https://cli.github.com/manual/gh_auth_setup-git).
