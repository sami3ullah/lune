import { Pill } from "./Pill";
import { ChatPanel } from "./ChatPanel";

// The renderer bundle backs two windows (ticket 06): the always-on-top Pill and the
// Chat Panel opened from it. The main process loads the Chat Panel window with the
// `#chat` hash, so the entry branches on it to mount the right surface. Both windows
// run this same bundle; each renders only its own surface.
export function App() {
  const isChatPanelSurface = window.location.hash === "#chat";
  return isChatPanelSurface ? <ChatPanel /> : <Pill />;
}
