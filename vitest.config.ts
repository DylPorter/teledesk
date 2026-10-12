import { defineConfig } from "vitest/config";

// Only the desk tests; legacy/tests run on node:test (npm run test:legacy).
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
