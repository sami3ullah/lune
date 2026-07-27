import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { SKILLS_ROUTE_HASH } from "../ipc/skills";

// The Skills window (M4-02): the surface opened from the Pill where the user browses the
// predefined starters, writes their own Skills, toggles each on or off, and sees which are
// shaping Lune's answers. Like Settings, it is its own frameless, opaque, always-on-top
// window rendering the shared bundle selected by a URL hash (`#skills`), shown with
// `showInactive` so opening it never yanks the user's active app to the background.

/** A comfortable fixed size for the Skills surface, in logical pixels (a touch taller than Settings for the editor). */
const SKILLS_SIZE = { width: 440, height: 640 };

/** How far below the menu bar/notch the window's top sits (clears the Pill), in logical pixels. */
const SKILLS_TOP_MARGIN = 52;

// There is exactly one Skills window; a module-level handle lets the toggle reuse it.
let skillsWindow: BrowserWindow | null = null;

/** Opens the Skills window when closed, hides it when open (the Pill menu shares this). */
export function toggleSkillsWindow(): void {
  if (skillsWindow && !skillsWindow.isDestroyed()) {
    if (skillsWindow.isVisible()) {
      skillsWindow.hide();
    } else {
      skillsWindow.showInactive();
    }
    return;
  }
  skillsWindow = createSkillsWindow();
}

function createSkillsWindow(): BrowserWindow {
  // Open top-center of the primary display, just below where the Pill floats.
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(primaryWorkArea.x + (primaryWorkArea.width - SKILLS_SIZE.width) / 2);
  const y = Math.round(primaryWorkArea.y + SKILLS_TOP_MARGIN);

  const window = new BrowserWindow({
    x,
    y,
    width: SKILLS_SIZE.width,
    height: SKILLS_SIZE.height,
    show: false,
    frame: false,
    // Opaque, not transparent: a full-rectangle panel like Settings (no rounded window
    // corners to preserve), and the dark backgroundColor avoids a white flash before paint.
    transparent: false,
    backgroundColor: "#171717",
    resizable: false,
    // Draggable by a CSS app-region on its header, like the Pill, Chat Panel, and Settings.
    movable: true,
    hasShadow: true,
    // A background companion: no taskbar/dock entry (developer story 40).
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // Float above ordinary windows and on every Space, matching the Pill, so Skills stays
  // reachable wherever the user is working.
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Show without activating so opening Skills never steals the user's focus.
  window.on("ready-to-show", () => window.showInactive());
  window.on("closed", () => {
    skillsWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${SKILLS_ROUTE_HASH}`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: SKILLS_ROUTE_HASH,
    });
  }

  return window;
}
