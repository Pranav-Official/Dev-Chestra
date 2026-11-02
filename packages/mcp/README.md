# @devchestra/mcp

The MCP transport for DevChestra. It has two halves:

- a stateless stdio shim that an agent CLI starts;
- a loopback HTTP gateway client used by that shim.

The shim never validates node output, persists results, or decides that an execution succeeded. Those are gateway/store/engine responsibilities.

## Entrypoints

| Surface | Path |
|---|---|
| Package exports | `dist/index.js` |
| Shim module | `dist/shim.js` |
| Built shim bin | `dist/bin/shim.js` (`devchestra-mcp-shim`) |
| Development launch | `node --import tsx packages/mcp/src/bin/shim.ts` |

Every exported type and function is re-exported from `src/index.ts`:

```ts
createAgentGatewayClient(options): Promise<AgentGatewayClient>
createShimServer(options): Promise<Server>
runShim(env?): Promise<void>
readShimConfig(env?): ShimOptions
deriveCallId(shimInstanceId, requestId): string
resolveLoopbackGatewayUrl(raw, lookupAll?): Promise<URL>
redactToken(text, token): string
GatewayClientError
AgentCallResult, AgentToolDescriptor, AgentGatewayClient, AgentToolCallInput,
AgentCallRequest, AgentToolsResponse, AgentTextContent, GatewayClientOptions,
GatewayErrorCode, LoopbackAddress, JsonRpcRequestId, ShimOptions
```

## Required shim environment

| Variable | Meaning |
|---|---|
| `DEVCHESTRA_EXEC_TOKEN` | Bearer exec token. Sent only in `Authorization`; never argv, stdout or logs. |
| `DEVCHESTRA_GATEWAY_URL` | Base gateway URL. Plain HTTP on a loopback literal (`127.0.0.1` or `[::1]`). `localhost` is accepted only when every resolved address is loopback, then rewritten to the literal to avoid DNS rebinding. Credentials, queries, fragments and redirects are rejected. |
| `DEVCHESTRA_TOOLSET` | `agent` or `supervisor`. The gateway remains authoritative from the token scope. |

Optional operational knobs:

`DEVCHESTRA_DEFAULT_TIMEOUT_MS` (30000), `DEVCHESTRA_SUBMIT_TIMEOUT_MS` (60000),
`DEVCHESTRA_GATEWAY_RETRIES` (1 extra attempt for network/502/503/504),
`DEVCHESTRA_MAX_REQUEST_BYTES` (1 MiB), `DEVCHESTRA_MAX_RESPONSE_BYTES` (256 KiB),
`DEVCHESTRA_MCP_DEBUG=1` (stderr diagnostics only).

## Gateway protocol

```text
GET  /internal/agent/tools
  Authorization: Bearer <exec token>
  200 { tools: [{ name, description?, inputSchema }] }

POST /internal/agent/call
  Authorization: Bearer <exec token>
  X-DevChestra-Call-Id: <stable transport receipt id>
  { "name": string, "arguments": object }
  200 { content: [{ type: "text", text: string }], isError: boolean }
  401 E_AUTH  403 E_FORBIDDEN  429 rate limited
```

The `callId` is a header so the body stays the spec's `{ name, arguments }`
shape. The shim forwards `isError` and text unchanged (apart from redacting the
exec token). A malformed gateway result becomes `isError: true`; a gateway HTTP
error body is preserved in the tool-error text. Cookies are never forwarded,
and `fetch` uses `redirect: "error"` so a redirect cannot carry the bearer
token to another host. Tools are cached for the shim process lifetime after a
successful `tools/list`.

## Receipt identity and its boundary

`deriveCallId(shimInstanceId, requestId)` produces the `X-DevChestra-Call-Id` value.

- It tags the MCP JSON-RPC id by type: numeric `1` and string `"1"` differ.
- One shim process has one random `shimInstanceId`; the same MCP request id in
  that process yields the same `callId`, so a transport retry reuses its receipt.
- Distinct model calls with identical arguments have distinct JSON-RPC ids and
  therefore distinct `callId`s.
- **MCP ids are not globally stable across restart.** A restarted shim gets a
  new instance id, so its `callId`s differ. Receipts must be persisted by the
  gateway bound to the server-authorized execution scope and generation
  (`runId`, `path`, `attempt`, `generation` in core's `ExecutionIdentity`).
  The shim deliberately does not claim more than that boundary.

## Security notes

- No token in argv, stdout, MCP content, or stderr diagnostics; gateway error
  text is token-redacted before it becomes a tool result.
- Loopback-only URL validation, no URL userinfo/query/fragment, no redirects,
  no browser-cookie auth, request and response size caps, abort/timeout support.
- The shim imports only the MCP SDK and Node built-ins. It does not import the
  engine, store, or workspace packages.

## Tests

`pnpm --filter @devchestra/mcp test` uses a real stdio SDK client against temporary
loopback HTTP listeners: tools/list, success, invalid submission, invalid
gateway result, retry receipt reuse, distinct call ids, numeric vs string ids,
missing env, unreachable gateway, timeout/abort, limits, URL safety, redirect
rejection, token redaction, and stdout protocol cleanliness.
