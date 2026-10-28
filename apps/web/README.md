# @devchestra/web

Read-only React 19 + Vite viewer for DevChestra projects, runs, live events and replay. Snapshots are
never edited from the UI and the viewer never starts or resumes a run — those mutations remain
CLI/API only. The single exception is the run-level Stop control, which posts to the existing
`POST /api/runs/:rid/cancel` endpoint.

## Commands

```sh
# From the repository root
pnpm install --frozen-lockfile
pnpm --filter @devchestra/web build         # production dist for devchestra start
pnpm --filter @devchestra/web typecheck
pnpm --filter @devchestra/web test

# Serve the built app with the real API and session cookie
pnpm devchestra start --data-dir /tmp/devchestra-dev --allow-experimental-adapters \
  --no-open --print-url

# Full P2 acceptance, including a real Chromium run page and axe checks
pnpm demo:p2
```

`devchestra start` serves `apps/web/dist` from the same loopback origin as `/api`. Restart `devchestra start`
after rebuilding the web app: the server caches `index.html` in memory at startup.

## Routes

- `/` — projects and recent runs
- `/p/:pid/runs` — project runs, filters and paging
- `/p/:pid/r/:rid?path=<execPath>&tab=detail|events|transcript&at=<eventId>` — run viewer
- `/p/:pid` redirects to `/p/:pid/runs`

## Data and correctness

- REST types and the `ApiClient` come from `@devchestra/api`; `RunView` comes from `@devchestra/core`.
- Bootstrap reads one atomic `{run, view, snapshot, watermark}` response, then fetches the complete
  event history at or below the watermark in bounded pages. A partial history is never reported as
  complete.
- The run stream uses native same-origin `EventSource` (cookies work) with the typed
  `@devchestra/api` frame parser. Frames are deduplicated and applied strictly by global event id, not by
  array position. Gaps between a run's ids are normal.
- One run stream is open at a time; one global hint stream invalidates cached lists and bootstrap
  counts. Both are closed on route change/unmount. Offline/online browser events immediately pause
  and resume the run stream from the last applied cursor.
- Overflow refetches the snapshot and complete history, then resubscribes after the last safe
  cursor. A reconnect banner appears after three seconds offline.
- Replay restores the nearest checkpoint (every 50 events) and reduces forward with the shared
  reducer. The replay view is derived from events only, so latest output, transcript and process
  data are not shown as if they existed at that past event.
- The event list renders a 100-row window. Transcript pages are lazy and the newest 2,000 lines are
  rendered at most. All agent text is a React text node; there is no
  `dangerouslySetInnerHTML`.
- The run page topbar carries one run-level Stop control, independent of the selected node and
  tab. It renders while the authoritative live head status is nonterminal (including
  paused and waiting-for-approval runs) and unmounts once the head turns terminal. While
  replaying, the button is labelled "Stop live run" and still acts on the live head, never on
  the replay position. `cancelRun` resolves as accepted (the controller reports the early
  `running` status for active runs while cancellation completes asynchronously), so the UI
  stays in "Stopping…" — busy and disabled — until live terminal evidence arrives via the
  stream; it never marks the run Cancelled optimistically and a second click after the 202
  does not re-post. Failures surface an inline retry/dismiss error; a terminal head meanwhile
  suppresses the error as a completion race.
- Theme preference is UI-only (`data-theme`, `data-theme-mode`, `localStorage: devchestra.theme`) and
  defaults to `prefers-color-scheme`. No gradients, external fonts or CDNs.

## Known limits

- This milestone has no editor, settings, approval, budget, artifact or supervisor controls.
- Replay requires the full event history. History beyond the bounded 100,000-event window is
  reported as unavailable instead of being silently truncated.
- Historical output content is not in the event log, so replay shows output ids/hashes and marks
  the content unavailable.
