import { useEffect, useState } from "react";
import type { ConfirmGateViewValue } from "../ipc/confirmGate";

// The Confirm Gate chip (M2-04): the on-screen way to answer a Screen Agent gate, shown in
// its own small focusable window (see `confirmGateWindow`). It renders the plain-language
// explanation the main process builds and two buttons - Approve and Cancel - and reports
// the press back over IPC. The hotkey and voice are the other two ways to answer the same
// gate; whichever answers first wins (the main process reconciles them), so this component
// only needs to report a button press and then wait to be told to close.

/** The palette is self-contained (this window has no shared stylesheet dependency). */
const APPROVE_COLOR = "#2f6f4f";
const CANCEL_COLOR = "#8a2f2f";

export function ConfirmGate() {
  const [view, setView] = useState<ConfirmGateViewValue | null>(null);
  /** Latches once a button is pressed, so a double-click can't report two answers. */
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    return window.lune.confirmGate.onEvent((event) => {
      if (event.type === "open") {
        setView(event.view);
        setAnswered(false);
      } else {
        setView(null);
      }
    });
  }, []);

  if (view === null) {
    return null;
  }

  const answer = (intent: "approve" | "cancel"): void => {
    if (answered) {
      return;
    }
    setAnswered(true);
    window.lune.confirmGate.answer({ intent });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: "100vh",
        boxSizing: "border-box",
        padding: 20,
        borderRadius: 16,
        background: "rgba(28, 28, 32, 0.96)",
        color: "#f4f4f6",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        userSelect: "none",
      }}
    >
      <div style={{ fontSize: 12, letterSpacing: 0.4, textTransform: "uppercase", opacity: 0.6 }}>
        {view.kind === "confirm-to-start" ? "Start acting on your screen?" : "Confirm this step"}
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.4, flex: 1 }}>{view.explanation}</div>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          type="button"
          onClick={() => answer("cancel")}
          disabled={answered}
          style={buttonStyle(CANCEL_COLOR)}
        >
          No, stop
        </button>
        <button
          type="button"
          onClick={() => answer("approve")}
          disabled={answered}
          style={buttonStyle(APPROVE_COLOR)}
        >
          Yes, go ahead
        </button>
      </div>
    </div>
  );
}

function buttonStyle(background: string): React.CSSProperties {
  return {
    flex: 1,
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background,
    color: "#ffffff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  };
}
