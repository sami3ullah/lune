import { describe, expect, it } from "vitest";
import { LUNE_IPC_VERSION } from "@lune/shared";
import { describeCore, handlePing } from "../src/index";

// This is the successor of v1's Endpoint Contract integration tests, with HTTP
// removed: it calls the Core's public API exactly as the Electron main process
// does and asserts on the returned values (Testing Decisions). For the scaffold
// there is only the placeholder ping; ported Capability suites join it later.
describe("Lune Core scaffold", () => {
  it("describes itself with the current IPC contract version", () => {
    expect(describeCore()).toContain(`IPC v${LUNE_IPC_VERSION}`);
  });

  it("echoes a ping into a validated shared-contract response", () => {
    const pingResponse = handlePing({ sentFromShellAtEpochMs: 1_000 });

    expect(pingResponse.ipcVersion).toBe(LUNE_IPC_VERSION);
    expect(pingResponse.receivedByCoreAtEpochMs).toBe(1_000);
    expect(pingResponse.coreDescription).toBe(describeCore());
  });
});
