import { readFile, readdir } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
export async function migrate(database: Pool | PoolClient) {
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await database.query(await readFile(new URL(file, directory), "utf8"));
}
