import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const source = resolve(root, "packages/adapters/native/windows-process.cs");
  const output = resolve(root, "packages/adapters/dist/native/windows-process.exe");
  if (!existsSync(output) || statSync(source).mtimeMs > statSync(output).mtimeMs) {
    const compiler = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    );
    mkdirSync(resolve(output, ".."), { recursive: true });
    execFileSync(compiler, ["/nologo", "/optimize+", "/platform:x64", `/out:${output}`, source], {
      stdio: "inherit",
      windowsHide: true,
    });
  }
}
