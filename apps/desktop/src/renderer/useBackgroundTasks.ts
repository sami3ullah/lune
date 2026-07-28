import { useEffect, useState } from "react";
import { reduceAgentCards, seedAgentCards, type AgentCard } from "./agentCards";

// A small live view of the background Task Agents, for surfaces other than the Agent Stack -
// namely the Pill, which shows a count and an entry to bring the stack back after its cards
// have been dismissed. It folds the same Task Agent event stream the Agent Stack uses through
// the same pure reducer, seeded from the runtime's current snapshots on mount, so the Pill and
// the stack never disagree about what's running.

/** A live count of the background Task Agents, for the Pill's badge and menu entry. */
export interface BackgroundTasksView {
  /** How many sessions are still running (the attention signal the Pill badges). */
  runningCount: number;
  /** How many sessions the runtime is tracking in total (running + finished this session). */
  totalCount: number;
}

/**
 * Subscribes to the Task Agent stream and returns a live count of background work. Mirrors the
 * Agent Stack's own seed-then-stream wiring: it subscribes first, then seeds from `list()`, so
 * an event arriving during startup is never lost.
 */
export function useBackgroundTasks(): BackgroundTasksView {
  const [tasks, setTasks] = useState<AgentCard[]>([]);

  useEffect(() => {
    const unsubscribe = window.lune.taskAgent.onTaskAgentEvent((event) => {
      setTasks((previous) => reduceAgentCards(previous, event));
    });
    // The Pill mounts at startup, so its seed can race the main-process handler registration:
    // a not-yet-ready `list()` just leaves the count empty until the live stream fills it in.
    void window.lune.taskAgent
      .list()
      .then((snapshots) => setTasks((previous) => seedAgentCards(previous, snapshots)))
      .catch(() => {});
    return unsubscribe;
  }, []);

  return {
    runningCount: tasks.filter((task) => task.status === "running").length,
    totalCount: tasks.length,
  };
}
