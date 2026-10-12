import { execFileSync } from "node:child_process";
const project = process.env.INGEST_PROJECT_ID;
const branch = process.env.INGEST_BRANCH_ID;
if (!project || !branch)
  throw new Error("Set the dedicated INGEST_PROJECT_ID and INGEST_BRANCH_ID");
const base = [
  "scripts/neon.mjs",
  "--profile",
  process.env.NEON_PROFILE ?? "staging",
];
const target = ["--project-id", project, "--branch", branch];
const run = (args, capture = false) =>
  execFileSync(process.execPath, [...base, ...args], {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
run(["deploy", ...target, "--env", ".env.local", "--no-env-pull", "--yes"]);
if (process.env.ENABLE_INGEST === "1") {
  const result = JSON.parse(
    run(["triggers", "list", ...target, "--output", "json"], true),
  );
  const triggers = Array.isArray(result) ? result : result.triggers;
  const trigger = triggers.find((value) => value.name === "hnminute");
  if (!trigger) throw new Error("The hnminute trigger was not created");
  if (!trigger.trigger_id)
    throw new Error("Missing trigger_id in CLI response");
  run(["triggers", "update", trigger.trigger_id, ...target, "--enabled=true"]);
}
