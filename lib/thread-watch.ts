import "server-only";
import { databasePool } from "./db";
import { updateThreadView } from "../ingest/thread-watch";
export function watchThread(id: number, viewer?: string, released = false) {
  return updateThreadView(databasePool(), id, viewer, released);
}
