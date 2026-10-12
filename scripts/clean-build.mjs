import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, `.local/clean-build-${Date.now()}`);
await mkdir(directory, { recursive: true });
const paths = [
  "app",
  "lib",
  "ingest",
  "functions",
  "scripts",
  "migrations",
  "tests",
  "package.json",
  "package-lock.json",
  "neon-toolchain.lock.json",
  "tsconfig.json",
  "next.config.ts",
  "next-env.d.ts",
  "neon.ts",
  ".gitignore",
  ".vercelignore",
];
for (const path of paths)
  await cp(resolve(root, path), resolve(directory, path), { recursive: true });
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: directory,
    stdio: "inherit",
    env: process.env,
  });
run("node", ["scripts/bootstrap.mjs"]);
run("npm", ["ci"]);
run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
// The production fixture guard and dynamic SSR allow building without secrets.
run("npm", ["run", "build"]);
await writeFile(
  resolve(root, ".local/clean-build-result.json"),
  JSON.stringify(
    {
      directory,
      passedAt: new Date().toISOString(),
      commit: JSON.parse(
        await readFile(resolve(root, "neon-toolchain.lock.json"), "utf8"),
      ).commit,
    },
    null,
    2,
  ),
);
