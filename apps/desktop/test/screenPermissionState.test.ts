import { describe, expect, it } from "vitest";
import {
  deriveScreenPermissionState,
  type ScreenRecordingAccessStatus,
} from "../src/main/screenCapture/screenPermissionState";

describe("deriveScreenPermissionState", () => {
  it("reports not-determined before access has ever been requested", () => {
    expect(
      deriveScreenPermissionState({ mediaAccessStatus: "not-determined", captureProducedContent: null }),
    ).toBe("not-determined");
  });

  it("treats an unknown OS status as not-determined so the first attempt can prompt", () => {
    expect(
      deriveScreenPermissionState({ mediaAccessStatus: "unknown", captureProducedContent: null }),
    ).toBe("not-determined");
  });

  it.each<ScreenRecordingAccessStatus>(["denied", "restricted"])(
    "reports denied for a %s status",
    (mediaAccessStatus) => {
      expect(deriveScreenPermissionState({ mediaAccessStatus, captureProducedContent: null })).toBe(
        "denied",
      );
    },
  );

  it("reports granted when the OS grants access and no capture has been probed yet", () => {
    expect(
      deriveScreenPermissionState({ mediaAccessStatus: "granted", captureProducedContent: null }),
    ).toBe("granted");
  });

  it("reports granted when the OS grants access and a real capture produced content", () => {
    expect(
      deriveScreenPermissionState({ mediaAccessStatus: "granted", captureProducedContent: true }),
    ).toBe("granted");
  });

  it("reports granted-needs-relaunch when granted but a real capture came back empty", () => {
    // The macOS quirk: the toggle is on, but this pre-grant process gets black frames
    // until it relaunches.
    expect(
      deriveScreenPermissionState({ mediaAccessStatus: "granted", captureProducedContent: false }),
    ).toBe("granted-needs-relaunch");
  });
});
