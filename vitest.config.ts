import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    // Node 25+ ships a global localStorage that shadows happy-dom's (undefined without --localstorage-file).
    // Older Node rejects the unknown flag, so only pass it where it exists.
    execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage") ? ["--no-experimental-webstorage"] : [],
    include: ["lib/**/*.test.ts", "party/**/*.test.ts", "app/**/*.test.tsx", "components/**/*.test.tsx"],
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
