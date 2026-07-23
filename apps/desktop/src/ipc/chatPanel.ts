// The Shell's own renderer <-> main IPC for the Chat Panel window (ticket 06). Like
// the pill-control messages, this is pure window plumbing that never reaches the Core
// (a future HTTP adapter would never carry "open a window"), so it lives here rather
// than in @lune/shared.

/**
 * Renderer -> main (send): open the Chat Panel if it is closed, or hide it if it is
 * already open. Used both by the Pill's "Chat Panel" menu item and the panel's own
 * close button - a single toggle keeps the two in agreement without extra channels.
 */
export const CHAT_PANEL_TOGGLE_CHANNEL = "lune:chat-panel:toggle";
