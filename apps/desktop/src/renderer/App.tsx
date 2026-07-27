import { Pill } from "./Pill";
import { ChatPanel } from "./ChatPanel";
import { Overlay } from "./Overlay";
import { Settings } from "./Settings";
import { Skills } from "./Skills";
import { Onboarding } from "./Onboarding";

// The renderer bundle backs every window: the always-on-top Pill, the Chat Panel opened
// from it (ticket 06), the full-screen click-through Overlay hosting the playful cursor +
// response bubble (ticket 07), the Settings surface (ticket 13), and the first-run
// Onboarding window (ticket 14). The main process loads each non-Pill window with a route
// hash (`#chat`, `#overlay`, `#settings`, `#skills`, `#onboarding`), so the entry branches
// on it to mount the right surface. Every window runs this same bundle and renders only its own.
export function App() {
  const routeHash = window.location.hash;
  if (routeHash === "#chat") {
    return <ChatPanel />;
  }
  if (routeHash === "#overlay") {
    return <Overlay />;
  }
  if (routeHash === "#settings") {
    return <Settings />;
  }
  if (routeHash === "#skills") {
    return <Skills />;
  }
  if (routeHash === "#onboarding") {
    return <Onboarding />;
  }
  return <Pill />;
}
