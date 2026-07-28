import { Pill } from "./Pill";
import { ChatPanel } from "./ChatPanel";
import { Overlay } from "./Overlay";
import { Settings } from "./Settings";
import { Skills } from "./Skills";
import { Integrations } from "./Integrations";
import { Onboarding } from "./Onboarding";
import { AgentStack } from "./AgentStack";

// The renderer bundle backs every window: the always-on-top Pill, the Chat Panel opened
// from it (ticket 06), the full-screen click-through Overlay hosting the playful cursor +
// response bubble (ticket 07), the Settings surface (ticket 13), and the first-run
// Onboarding window (ticket 14), and the Agent Stack of background Task Agent cards (M5-03).
// The main process loads each non-Pill window with a route hash (`#chat`, `#overlay`,
// `#settings`, `#skills`, `#integrations`, `#onboarding`, `#agentStack`), so the entry branches
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
  if (routeHash === "#integrations") {
    return <Integrations />;
  }
  if (routeHash === "#agentStack") {
    return <AgentStack />;
  }
  if (routeHash === "#onboarding") {
    return <Onboarding />;
  }
  return <Pill />;
}
