import { Pill } from "./Pill";

// The renderer's single window in M1 is the Pill - Lune's always-on-top home
// surface (ticket 04). The walking-skeleton chat plumbing (the store and the chat
// bridge over typed IPC) stays in place for the Chat Panel ticket to build on; the
// Pill's "Chat Panel" menu item is a placeholder until that surface exists.
export function App() {
  return <Pill />;
}
