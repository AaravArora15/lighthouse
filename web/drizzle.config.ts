/**
 * drizzle-kit config.
 *
 * Only used by `npx drizzle-kit push` / `generate` / `studio`. Nothing in the running app
 * imports this, so it is the one place allowed to reach for `DATABASE_URL` eagerly.
 */

import { existsSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next, which is what loads `.env.local` for the app. Node's own
// loader covers it without pulling in dotenv for a single build-time script.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy web/env.example to web/.env.local and fill it in.",
  );
}

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
