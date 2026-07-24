import { describe, expect, it } from "vitest";

import { deriveAccessibilityPermissionState } from "../src/main/permissions/accessibilityPermissionState";

/**
 * Unit tests for the Accessibility permission state derivation (M1 onboarding's
 * permissions step, live-detected). macOS exposes Accessibility as a single
 * trusted/not-trusted bit, so the fold is a straight two-way mapping.
 */
describe("deriveAccessibilityPermissionState", () => {
  it("maps a trusted client to granted", () => {
    expect(deriveAccessibilityPermissionState(true)).toBe("granted");
  });

  it("maps an untrusted client to not-granted", () => {
    expect(deriveAccessibilityPermissionState(false)).toBe("not-granted");
  });
});
