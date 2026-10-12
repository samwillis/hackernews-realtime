import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
const environment = process.argv[2] ?? "preview";
if (!["preview", "production"].includes(environment))
  throw new Error("Choose preview or production");
const values = parseEnv(
  await readFile(new URL("../.env.local", import.meta.url), "utf8"),
);
const project = JSON.parse(
  await readFile(new URL("../.vercel/project.json", import.meta.url), "utf8"),
);
for (const key of [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "NEON_REALTIME_SECRET",
  "NEXT_PUBLIC_NEON_REALTIME_URL",
]) {
  if (!values[key]) throw new Error(`Missing ${key}`);
  // Feed credentials over stdin, never as command arguments or in logs.
  if (key.startsWith("NEXT_PUBLIC_")) {
    const url = new URL(values[key]);
    if (url.protocol !== "wss:" || url.username || url.password || url.search)
      throw new Error(
        "The browser URL must be a public WebSocket endpoint without credentials",
      );
    execFileSync(
      "vercel",
      [
        "api",
        `/v10/projects/${project.projectId}/env?upsert=true&teamId=${project.orgId}`,
        "--method",
        "POST",
        "--input",
        "-",
        "--silent",
      ],
      {
        input: JSON.stringify({
          key,
          value: url.href,
          type: "plain",
          target: [environment],
        }),
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
  } else
    execFileSync(
      "vercel",
      ["env", "add", key, environment, "--force", "--yes"],
      { input: values[key], stdio: ["pipe", "ignore", "inherit"] },
    );
  console.log(`Configured ${key} (${environment})`);
}
