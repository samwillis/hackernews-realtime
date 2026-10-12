import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const environment = process.argv[2] ?? "preview";
if (!["preview", "production"].includes(environment))
  throw new Error("Choose preview or production");
const local = parseEnv(await readFile(".env.local", "utf8"));
const path = `.vercel/.env.${environment}.local`;
const pulled = parseEnv(await readFile(path, "utf8"));
for (const key of [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "NEON_REALTIME_SECRET",
  "NEXT_PUBLIC_NEON_REALTIME_URL",
]) {
  if (!local[key]) throw new Error(`Missing ${key}`);
  pulled[key] = local[key];
}
await writeFile(
  path,
  Object.entries(pulled)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
await chmod(path, 0o600);
console.log(`Prepared local ${environment} build environment`);
