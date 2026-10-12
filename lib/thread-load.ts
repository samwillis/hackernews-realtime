import "server-only";
import { databasePool } from "./db";
import { loadThread } from "../ingest/thread-load";
export async function ensureThreadLoaded(id: number) {
  try {
    await loadThread(databasePool(), id);
  } catch {
    // SSR still opens with cached rows; the live worker retries HN.
  }
}
