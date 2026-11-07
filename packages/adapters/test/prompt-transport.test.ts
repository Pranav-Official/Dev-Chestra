import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdapter, runAgent } from "../src/index.js";
import { request } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// Capture what a real child receives, after the runner's persistence hook and
// through EOF. Avoid putting the expected payload in argv or environment.
const RECEIVER = `#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
if (!existsSync(process.env.READY)) process.exit(8);
writeFileSync(process.env.RECEIVED, Buffer.concat(chunks));
const config = process.env.OPENCODE_CONFIG_CONTENT
  ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
  : JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), "utf8"));
writeFileSync(process.env.META, JSON.stringify({ argv: process.argv.slice(2), config }));
console.log(JSON.stringify(process.env.OPENCODE_CONFIG_CONTENT
  ? {type:"step_finish",part:{reason:"stop"}}
  : {type:"turn_end",message:{role:"assistant",content:[],stopReason:"stop"}}));
`;

describe.each(["opencode", "pi"] as const)("%s prompt transport", (cli) => {
  it.each([
    ["fresh", 33_227],
    ["resume", 33_227],
    ["fresh", 180_000],
    ["resume", 180_000],
  ] as const)("delivers %s input of %i characters through stdin", async (mode, size) => {
    const dir = await mkdtemp(join(tmpdir(), "devchestra prompt ü-"));
    dirs.push(dir);
    const bin = join(dir, "receiver.mjs");
    await writeFile(bin, RECEIVER);
    await chmod(bin, 0o755);
    const received = join(dir, "received.txt");
    const meta = join(dir, "meta.json");
    const ready = join(dir, "ready");
    const prompt = `- @not-a-file "quoted" \\path\\\n$(not-a-command) & | <data>é🙂漢字</data>\r\n${"x".repeat(size)}\nEND\n`;
    const adapter = createAdapter(cli, { opencodeBin: bin, piBin: bin });
    const sessionId = cli === "pi" ? "01a17f07-a112-774b-8984-a85600c262d6" : "ses_transport123";
    const planned = adapter.plan(
      request({
        mode,
        ...(mode === "resume" ? { sessionId } : {}),
        prompt,
        model: "opencode-go/test-model",
        cwd: dir,
        execDir: join(dir, "execution ü"),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          RECEIVED: received,
          META: meta,
          READY: ready,
        },
      }),
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw planned.error;
    expect(adapter.caps.promptViaStdin).toBe(true);
    expect(planned.value.stdin).toBe(prompt);
    expect(planned.value.args.join(" ")).not.toContain("not-a-command");
    const result = await runAgent(
      planned.value,
      {
        onSpawn: async () => {
          await writeFile(ready, "persisted");
        },
      },
      new AbortController().signal,
      { timeoutMs: 10_000, parser: adapter.parser() },
    );
    expect(result.code).toBe(0);
    expect(result.killedBy).toBeNull();
    expect(await readFile(received)).toEqual(Buffer.from(prompt, "utf8"));
    const captured = JSON.parse(await readFile(meta, "utf8"));
    expect(captured.argv).toContain("opencode-go/test-model");
    if (mode === "resume") expect(captured.argv).toContain(sessionId);
    if (cli === "opencode") {
      expect(captured.argv).toContain("--standalone");
      expect(captured.config.mcp.devchestra.enabled).toBe(true);
    } else {
      expect(captured.argv).toContain("--no-approve");
      expect(captured.config.mcpServers.devchestra.exposure).toBe("direct");
    }
  });
});
