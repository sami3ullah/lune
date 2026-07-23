import { defineConfig } from "vitest/config";

// M1 Shell testing is pure logic only - no Electron, no Playwright, no E2E (the M1
// test plan). These suites exercise the Shell's testable seams (pill geometry, IPC
// codecs) as plain Node unit tests; surface behavior is verified manually.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
