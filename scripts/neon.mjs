import { spawn } from "node:child_process";
import { resolve } from "node:path";
const child = spawn(
  process.execPath,
  [
    resolve(
      import.meta.dirname,
      "../.local/toolchains/neon-pkgs/packages/cli/dist/cli.js",
    ),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
