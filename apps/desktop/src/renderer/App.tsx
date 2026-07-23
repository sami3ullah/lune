import { Pill } from "./Pill";
import { ChatPanel } from "./ChatPanel";
import { Overlay } from "./Overlay";
import { Settings } from "./Settings";

// The renderer bundle backs three windows: the always-on-top Pill, the Chat Panel
// opened from it (ticket 06), and the full-screen click-through Overlay that hosts the
// playful cursor + response bubble (ticket 07). The main process loads each non-Pill
// window with a route hash (`#chat`, `#overlay`), so the entry branches on it to mount
// the right surface. Every window runs this same bundle and renders only its own surface.
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
  return <Pill />;
}
