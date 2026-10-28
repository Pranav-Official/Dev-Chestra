/** @type {import('dependency-cruiser').IConfiguration} */
const allowed = [
  { name: "core", path: "(^|/)packages/core/", deps: [] },
  { name: "config", path: "(^|/)packages/config/", deps: ["core"] },
  { name: "schema", path: "(^|/)packages/schema/", deps: ["core"] },
  { name: "store", path: "(^|/)packages/store/", deps: ["core"] },
  { name: "workspaces", path: "(^|/)packages/workspaces/", deps: ["core"] },
  { name: "decisions", path: "(^|/)packages/decisions/", deps: ["core", "schema"] },
  { name: "context", path: "(^|/)packages/context/", deps: ["core", "store"] },
  { name: "adapters", path: "(^|/)packages/adapters/", deps: ["core", "config", "schema"] },
  { name: "mcp", path: "(^|/)packages/mcp/", deps: ["core", "schema"] },
  {
    name: "engine",
    path: "(^|/)packages/engine/",
    deps: [
      "core",
      "schema",
      "store",
      "workspaces",
      "adapters",
      "mcp",
      "decisions",
      "context",
      "config",
    ],
  },
  { name: "supervisor", path: "(^|/)packages/supervisor/", deps: ["core", "engine"] },
  { name: "api", path: "(^|/)packages/api/", deps: ["core", "schema"] },
  {
    // P0 composition root: the gateway server wires the real store, MCP tool
    // surface and core contracts. Revisit when the engine owns composition.
    name: "server",
    path: "(^|/)packages/server/",
    deps: [
      "api",
      "engine",
      "supervisor",
      "config",
      "core",
      "schema",
      "store",
      "mcp",
      "adapters",
      "decisions",
    ],
  },
  {
    // P1 embedded CLI composition root: run/resume assemble the slice directly
    // until the engine/server boundary owns it. Keep this list narrow.
    name: "cli",
    path: "(^|/)packages/cli/",
    deps: ["core", "schema", "store", "workspaces", "adapters", "engine", "mcp", "server", "decisions"],
  },
  {
    // Browser editor/viewer. It may use the shared contracts, the typed API
    // client and the browser-safe schema main entry, never Node/server/engine
    // packages or @relay/schema/node.
    name: "web",
    path: "(^|/)apps/web/",
    deps: ["api", "core", "schema"],
  },
];

const directionRules = allowed.map(({ name, path, deps }) => {
  const reachable = [name, ...deps].join("|");
  return {
    name: `${name}-imports-only-allowed-packages`,
    severity: "error",
    comment: `@relay/${name} may import only itself${deps.length ? ` and ${deps.map((d) => `@relay/${d}`).join(", ")}` : ""}.`,
    from: { path },
    to: { path: `(^|/)packages/(?!(?:${reachable})/)` },
  };
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make the runtime composition order ambiguous.",
      from: {},
      to: { circular: true },
    },
    {
      name: "browser-safe-no-node-builtins",
      severity: "error",
      comment:
        "Browser-safe code (@relay/core, @relay/schema, @relay/api, apps/web) must not require Node built-ins. The explicit @relay/schema/node subpath and Node-only build configs are the only exceptions.",
      from: {
        path: "(^|/)(packages/(core|schema|api)|apps/web)/",
        pathNot:
          "\\.(test|spec)\\.(ts|tsx)$|(^|/)packages/schema/src/node/|(^|/)apps/web/(vite|vitest)\\.config\\.ts$",
      },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "packages-cannot-import-apps",
      severity: "error",
      comment:
        "Packages are libraries/ports; composition happens in server, cli or a tool. Apps sit above packages.",
      from: { path: "(^|/)packages/" },
      to: { path: "(^|/)apps/" },
    },
    {
      name: "apps-import-only-packages",
      severity: "error",
      comment: "Apps compose packages; one app must not depend on another app's source.",
      from: { path: "(^|/)apps/" },
      to: { path: "(^|/)(apps/(?!web/)|tools/)" },
    },
    {
      name: "schema-main-cannot-import-node-subpath",
      severity: "error",
      comment:
        "@relay/schema main stays browser-safe. Node-only helpers live under src/node and are imported through the explicit @relay/schema/node entry.",
      from: {
        path: "(^|/)packages/schema/src/",
        pathNot: "(^|/)packages/schema/src/node/",
      },
      to: { path: "(^|/)packages/schema/src/node/" },
    },
    {
      name: "web-cannot-import-schema-node-subpath",
      severity: "error",
      comment:
        "apps/web may import the browser-safe @relay/schema main entry only; the Node JSONata executor stays server-side.",
      from: { path: "(^|/)apps/web/" },
      to: { path: "(^|/)packages/schema/src/node/" },
    },
    ...directionRules,
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: ["(^|/)(dist|coverage|test-data|\\.relay)/", "\\.d\\.ts$"],
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    reporterOptions: {
      dot: { collapsePattern: "node_modules/[^/]+" },
    },
  },
};
