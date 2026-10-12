import { execFileSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lockPath = resolve(root, "neon-toolchain.lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
if (process.versions.node !== lock.node)
  throw new Error(
    `Use Node ${lock.node} to reproduce the Neon package artifacts`,
  );
const run = (command, args, cwd, capture = false) =>
  execFileSync(command, args, {
    cwd,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: { ...process.env, HUSKY: "0" },
  });
const source = resolve(
  process.env.NEON_PKGS_DIR || resolve(root, ".local/toolchains/neon-pkgs"),
);
await mkdir(resolve(root, ".local/toolchains"), { recursive: true });
try {
  await access(resolve(source, ".git"));
} catch {
  if (process.env.NEON_PKGS_DIR)
    throw new Error("NEON_PKGS_DIR does not exist");
  run(
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", lock.repository, source],
    root,
  );
}
if (!process.env.NEON_PKGS_DIR) {
  run("git", ["fetch", "origin", lock.commit], source);
  run("git", ["checkout", "--detach", lock.commit], source);
}
if (
  run("git", ["rev-parse", "HEAD"], source, true).trim() !== lock.commit ||
  run("git", ["status", "--porcelain"], source, true).trim()
) {
  throw new Error("Neon checkout must be clean and match the pinned commit");
}
run(
  "npx",
  ["--yes", lock.packageManager, "install", "--frozen-lockfile"],
  source,
);
const filters = [...lock.packages.map((name) => `@neon/${name}...`), "neon..."];
run(
  "npx",
  [
    "--yes",
    lock.packageManager,
    ...filters.flatMap((value) => ["--filter", value]),
    "build",
  ],
  source,
);
const destination = resolve(root, ".sdk");
await mkdir(destination, { recursive: true });
async function normalizeDistribution(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await normalizeDistribution(path);
    else if (entry.name.endsWith(".map")) await rm(path);
    else if (/\.(js|ts)$/.test(entry.name)) {
      const content = await readFile(path, "utf8");
      await writeFile(
        path,
        content.replace(/^\/\/[@#] sourceMappingURL=.*\r?\n?/gm, ""),
      );
    }
  }
}
for (const name of lock.packages) {
  const packageDir = resolve(source, "packages", name);
  const metadata = JSON.parse(
    await readFile(resolve(packageDir, "package.json"), "utf8"),
  );
  delete metadata.scripts;
  delete metadata.devDependencies;
  for (const section of ["dependencies", "peerDependencies"]) {
    for (const [dependency, version] of Object.entries(
      metadata[section] || {},
    )) {
      if (!version.startsWith("workspace:")) continue;
      const sibling = dependency.replace("@neon/", "");
      if (!lock.packages.includes(sibling))
        throw new Error(`Missing runtime closure: ${dependency}`);
      metadata[section][dependency] = JSON.parse(
        await readFile(
          resolve(source, "packages", sibling, "package.json"),
          "utf8",
        ),
      ).version;
    }
  }
  const temporary = await mkdtemp(resolve(tmpdir(), "hn-sdk-"));
  try {
    await writeFile(
      resolve(temporary, "package.json"),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    for (const file of metadata.files) {
      if (file !== "package.json")
        await cp(resolve(packageDir, file), resolve(temporary, file), {
          recursive: true,
        });
    }
    // The prerelease declaration bundler emits nondeterministic mapping names.
    // Source maps are optional debugging artifacts; exclude them, retaining
    // identical runtime JavaScript and type declarations in reproducible packs.
    await normalizeDistribution(temporary);
    const [{ filename }] = JSON.parse(
      run(
        "npm",
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          destination,
        ],
        temporary,
        true,
      ),
    );
    const target = `neon-${name}.tgz`;
    await rename(resolve(destination, filename), resolve(destination, target));
    const integrity =
      "sha512-" +
      createHash("sha512")
        .update(await readFile(resolve(destination, target)))
        .digest("base64");
    if (process.argv.includes("--update-integrity"))
      lock.integrities[target] = integrity;
    else if (lock.integrities[target] !== integrity)
      throw new Error(`Package integrity mismatch: ${target}`);
    console.log(`Verified ${target}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv.includes("--update-integrity"))
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
