import { describe, expect, it } from "vitest";

import { deriveMicPermissionState } from "../src/main/permissions/micPermissionState";

/**
 * Unit tests for the microphone permission state derivation (ticket 14: onboarding's
 * permissions step, live-detected). Unlike Screen Recording there is no relaunch quirk,
 * so the mapping is a direct fold of the OS status into the three states the UI acts on.
 */
describe("deriveMicPermissionState", () => {
  it("maps a granted mic to granted", () => {
    expect(deriveMicPermissionState("granted")).toBe("granted");
  });

  it("maps denied and restricted to denied (System Settings is the only path)", () => {
    expect(deriveMicPermissionState("denied")).toBe("denied");
    expect(deriveMicPermissionState("restricted")).toBe("denied");
  });

  it("maps not-determined and unknown to not-determined (the first request prompts)", () => {
    expect(deriveMicPermissionState("not-determined")).toBe("not-determined");
    expect(deriveMicPermissionState("unknown")).toBe("not-determined");
  });
});
