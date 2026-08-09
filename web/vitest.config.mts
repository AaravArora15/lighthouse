import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the `@/*` alias from tsconfig.json natively, so the tests import exactly the
  // same module specifiers the app does.
  resolve: { tsconfigPaths: true },
  test: {
    // Behaviour tests must run offline: no API key, no database, no network. Nothing under
    // src/lib reaches the network, and the conformance fixtures are files on disk.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
