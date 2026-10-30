# Native Windows compatibility spike

Branch: `spike/windows-native`. Target: Windows 10/11 x64, Node 22 or newer,
pnpm 10.14.0 and Git for Windows. Runs directly in Windows using existing
Windows agent installations and authentication. WSL is not involved.

## Setup and use

From the checkout in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm build
Push-Location packages/cli
npm link --ignore-scripts
Pop-Location
devchestra start
```

From another PowerShell window, in any directory:

```powershell
devchestra status
devchestra stop
devchestra stop --force
```

`start` stays in the foreground and opens the Windows browser. Ctrl+C also
requests graceful shutdown. A second `start` attaches to the verified instance.
The global npm link points to this checkout; rebuild after changes and restart
the server to use them. Remove it with `npm uninstall -g @devchestra/cli`.

Default state: `%LOCALAPPDATA%\devchestra`. `DEVCHESTRA_DATA_DIR` and
`--data-dir` still override it. Enter ordinary Windows project paths in the UI,
for example `D:\Misc\MyProject`. No Windows-to-WSL path translation is used.

## Implementation

- Windows process identities use PID plus the OS process creation time, queried
  by a small C# helper. Orphan cleanup checks recorded creation time and binary;
  termination rechecks the creation time using the opened process handle.
- Each agent, command wrapper and discovery process launches suspended into a
  Windows Job Object before it is resumed. The job has kill-on-close enabled
  with no breakaway permission. It owns all descendants, including agent tools.
  Completing the root CLI closes its job, terminating remaining descendants.
- The helper monitors the supervising Node process through an OS process handle.
  If that supervisor crashes, the helper exits and Windows closes the job. Job
  cancellation terminates the supervisor and waits for observed descendants to
  exit. Windows cancellation is immediate; it does not emulate POSIX SIGTERM.
- Graceful server stop uses a local named pipe and the server's random token.
  This lets the normal HTTP/SSE, engine, gateway, store and lock cleanup execute.
  `--force` can terminate an identity-checked unresponsive server and its tree.
- npm `.cmd` shims for Codex, OpenCode and Pi resolve to the referenced `.exe` or
  Node entrypoint. Agent arguments bypass `cmd.exe`, preserving quotes, spaces,
  Unicode, empty arguments and shell metacharacters. Native `.exe` files and
  Node shebang scripts are supported. Arbitrary batch programs are rejected;
  specify their real executable/entrypoint instead. PATH lookup does not add cwd.
- Child environments retain Windows PATH, system directories, profile, config
  and temporary-directory variables while preserving the existing allowlist and
  loader-variable restrictions. Windows profile paths also supply HOME where
  needed by adapters and MCP configuration discovery.
- Generated token/config directories receive protected Windows DACLs for the
  current user and SYSTEM. Server metadata is checked against its owner and DACL
  rather than POSIX mode bits. Reparse-point checks remain in place.
- Pi's isolated home uses staged credential/settings files on Windows, avoiding
  administrator privileges and Developer Mode. After the owned process has
  stopped, changed files are reconciled to their canonical paths while the
  existing DevChestra credential lock is held. Detected external changes cause
  a conflict and retain the isolated update instead of overwriting the other edit.
  Unix continues to use its existing symlinks.
- Windows shell nodes use Windows PowerShell with an encoded command and no
  profile. Template values use PowerShell single-quote escaping. Unsupported
  placeholder contexts (including block comments, here-strings, backticks and
  stop-parsing tokens) are rejected. Unix shell quoting is unchanged.
- Workspace layouts use platform path functions. Native drive paths, case and
  8.3 aliases work without relaxing junction/symlink rejection for selected
  worktrees. The production build copies the expression worker using Node fs.
- The pinned `better-sqlite3` build is allowed by pnpm. No WSL SQLite library or
  fallback driver is used.

The helper is compiled during `pnpm build` with Windows' .NET Framework C#
compiler into `packages/adapters/dist/native/windows-process.exe`. No downloaded
binary or system-wide native build toolchain is needed for this helper. SQLite
still requires its normal prebuilt package or native build prerequisites.

## Validation

Repeatable acceptance command: `pnpm test:windows`. A separate Windows GitHub
Actions workflow runs this acceptance set and typechecking on Node 22 and 24.
The workflow has been added but has not been run remotely.

Local result on Windows with Node 22.23.4: **29 acceptance tests passed**
(10 native/server tests and 19 process-runner tests). Workspace-wide
`pnpm typecheck`, dependency-cruiser and `git diff --check` passed. Global
`devchestra start`, `status` and `stop` also passed from outside the checkout;
the server was left stopped after verification.

Local acceptance covers:

- Native npm shim argument preservation and PowerShell interpolation, including
  injection-shaped strings and Unicode.
- Descendant cancellation, supervisor-crash cleanup and unrelated-process survival.
- Rejection of a mismatched recorded process creation time.
- Forced shutdown with an unavailable control pipe.
- Staged credential refresh and conflicting external edits using temporary fixtures.
- Creation, finalization and reopening of project-root, existing-worktree and
  new-worktree modes with spaces in their paths.
- A full fake-agent workflow through the MCP shim, authenticated submission,
  SQLite storage, PowerShell shell node and final result.
- The existing real-server start/status/graceful-stop end-to-end test.
- The existing 19 process-runner tests, with Windows identity/ACL expectations.

Read-only live probes on this machine returned:

| Windows CLI | Version | Model discovery |
| --- | --- | --- |
| Codex | 0.164.0 | ready, 8 models |
| Claude Code | 2.1.303 | ready, 5 models |
| OpenCode | 1.19.3 | ready, 207 models |
| Pi | 1.3.0 | ready, 100 models |

The probes used the installed Windows commands and normal authentication.
No real agent completion, paid inference or outgoing message was requested.

## Remaining before production support

This is an implementation spike, not a claim that the entire legacy suite passes
on Windows. Initial adapter/CLI/workspace suite runs exposed Unix path goldens,
POSIX permission assertions, symlink fixtures requiring Developer Mode, negative
PID cleanup and short timing budgets. The native acceptance set covers the core
runtime, but the remaining legacy fixtures still need porting and a full rerun.

Real Codex/Claude/OpenCode/Pi tool execution, native agent sandbox behavior,
interactive approval behavior and live mid-run recovery need dedicated provider
acceptance. Version/catalog success does not establish those behaviors. Browser
editor CRUD, save-conflict recovery, accessibility and browser automation also
need a complete Windows regression run.

Existing Unix shell workflows do not automatically become PowerShell workflows;
replace commands such as `printf` with their Windows equivalents. Shell commands
are platform-specific in this spike; there is no workflow-level shell selector.

If Windows or the supervisor crashes before Pi staging is reconciled, a newly
refreshed credential may remain only in the isolated invocation directory.
Automatic crash-time reconciliation is not implemented. Concurrent independent
Pi processes do not participate in DevChestra's credential lock.

The helper and Job Object implementation still need security and packaging
review. Windows ARM64, network shares, unusual/restricted process DACLs and
corporate policies blocking helper compilation/execution have not been validated.
Unix regression CI should pass before merging this branch into main.

## Platform references

- [Node.js child process documentation](https://nodejs.org/api/child_process.html):
  batch files require a command interpreter on Windows.
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects):
  child membership, suspended assignment and kill-on-close lifetime management.
