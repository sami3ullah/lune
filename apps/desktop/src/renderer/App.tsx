import { useState } from "react";
import { motion } from "framer-motion";
import { LUNE_IPC_VERSION } from "@lune/shared";
import { useWiringProofStore } from "./store";

// Scaffold surface: a single button that sends the placeholder ping across the
// typed IPC boundary (renderer -> preload -> main -> Core) and renders the Core's
// reply. It exists only to prove the whole architecture is wired end to end; the
// real Pill, Chat Panel, and Overlay are built in later tickets.
export function App() {
  const lastPingResponse = useWiringProofStore((state) => state.lastPingResponse);
  const recordPingResponse = useWiringProofStore((state) => state.recordPingResponse);
  const [isPingInFlight, setIsPingInFlight] = useState(false);

  async function sendPingThroughIpc() {
    setIsPingInFlight(true);
    try {
      const pingResponse = await window.lune.ping({
        sentFromShellAtEpochMs: Date.now(),
      });
      recordPingResponse(pingResponse);
    } finally {
      setIsPingInFlight(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-950 text-neutral-100">
      <motion.h1
        className="text-2xl font-semibold tracking-tight"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        Lune
      </motion.h1>

      <p className="text-sm text-neutral-400">
        Shared IPC contract v{LUNE_IPC_VERSION}
      </p>

      <button
        type="button"
        onClick={sendPingThroughIpc}
        disabled={isPingInFlight}
        className="cursor-pointer rounded-full bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-default disabled:opacity-50"
      >
        {isPingInFlight ? "Pinging Core..." : "Ping Core over IPC"}
      </button>

      {lastPingResponse && (
        <pre className="rounded-lg bg-neutral-900 px-3 py-2 text-xs text-emerald-300">
          {lastPingResponse.coreDescription}
        </pre>
      )}
    </div>
  );
}
