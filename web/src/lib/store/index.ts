/**
 * Store selection.
 *
 * `LIGHTHOUSE_STORE` decides, and when it is unset the presence of `DATABASE_URL` decides.
 * Tests never touch either: they call `createMemoryStore()` directly, so a stray
 * `DATABASE_URL` in a developer's shell cannot quietly point the offline suite at a real
 * database.
 *
 * The Postgres module is loaded through a dynamic `import()` so the Neon driver is never
 * pulled into a process that is not going to use it — which keeps the test import graph
 * genuinely free of database code rather than merely unexercised.
 */

import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";

export * from "@/lib/store/types";
export { createMemoryStore };

let cached: Promise<Store> | null = null;

export function store(): Promise<Store> {
  cached ??= select();
  return cached;
}

async function select(): Promise<Store> {
  const choice = process.env.LIGHTHOUSE_STORE;
  const url = process.env.DATABASE_URL;

  if (choice === "memory") return createMemoryStore();

  if (choice === "postgres" && !url) {
    throw new Error("LIGHTHOUSE_STORE=postgres but DATABASE_URL is not set.");
  }

  if (url) {
    const { createPostgresStore } = await import("@/lib/store/postgres");
    return createPostgresStore(url);
  }

  // Loud, because the failure it prevents is silent: overrides and audit rows written to
  // a Map on a serverless instance vanish, and the console shows no sign that they did.
  console.warn(
    "[lighthouse] No DATABASE_URL — using the in-memory store. Overrides and the audit " +
      "log will not survive a restart, and on serverless they will not survive a request.",
  );
  return createMemoryStore();
}

/** Test and script hook. Replaces the process-wide store; never called by the app. */
export function __setStore(s: Store): void {
  cached = Promise.resolve(s);
}
