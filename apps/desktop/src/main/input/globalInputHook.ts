// The one shared owner of the `uiohook-napi` global input hook. The native hook is a
// process-wide singleton (one event tap, one `start()`/`stop()` pair), but two features
// listen to it: push-to-talk (keydown/keyup, ./../voice/globalKeyEventSource) and the
// teaching-overlay scroll dismissal (wheel, wired in main/index). If each feature called
// `uIOhook.start()`/`stop()` itself, one stopping would silently kill the other's events -
// so this module refcounts subscribers, loads the native module lazily (a missing/broken
// native module degrades that feature, never crashes the app), starts the hook when the
// first subscriber attaches, and stops it when the last one leaves.

/** The subset of a `uiohook-napi` keyboard event the subscribers read. */
export interface UiohookKeyboardEvent {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The subset of a `uiohook-napi` wheel (scroll) event the subscribers read. */
export interface UiohookWheelEvent {
  rotation: number;
  direction: number;
}

/** The global input events a subscriber can listen to; omit what it doesn't need. */
export interface GlobalInputHandlers {
  keydown?: (event: UiohookKeyboardEvent) => void;
  keyup?: (event: UiohookKeyboardEvent) => void;
  wheel?: (event: UiohookWheelEvent) => void;
}

/** The part of the loaded module a subscriber may need to build its handlers (keycode names). */
export interface UiohookModuleSurface {
  UiohookKey: Record<string, number>;
}

type UiohookListener = (event: never) => void;

/** The subset of the `uiohook-napi` module surface this module uses. */
interface UiohookModule extends UiohookModuleSurface {
  uIOhook: {
    on(eventName: string, listener: UiohookListener): void;
    removeListener(eventName: string, listener: UiohookListener): void;
    start(): void;
    stop(): void;
  };
}

/** One attached subscriber: its handlers, kept so dispose can detach exactly them. */
interface AttachedSubscription {
  handlers: GlobalInputHandlers;
}

// The lazily-started module load, shared by every subscriber (resolves `null` on a load
// failure, in which case global input features are simply inactive rather than crashing).
let modulePromise: Promise<UiohookModule | null> | null = null;
// The subscriptions whose handlers are currently attached to the hook's emitter.
const attachedSubscriptions = new Set<AttachedSubscription>();
// Whether `uIOhook.start()` has been called (and not yet balanced by `stop()`).
let hookRunning = false;

function loadModule(): Promise<UiohookModule | null> {
  if (modulePromise === null) {
    modulePromise = import("uiohook-napi")
      .then((imported) => imported as unknown as UiohookModule)
      .catch((error) => {
        console.error("[lune] global input hook unavailable:", error);
        return null;
      });
  }
  return modulePromise;
}

function attach(module: UiohookModule, subscription: AttachedSubscription): void {
  const { handlers } = subscription;
  if (handlers.keydown) {
    module.uIOhook.on("keydown", handlers.keydown as UiohookListener);
  }
  if (handlers.keyup) {
    module.uIOhook.on("keyup", handlers.keyup as UiohookListener);
  }
  if (handlers.wheel) {
    module.uIOhook.on("wheel", handlers.wheel as UiohookListener);
  }
  attachedSubscriptions.add(subscription);
  if (!hookRunning) {
    // First subscriber: start the one native event tap. If the OS refuses (Input
    // Monitoring withheld), uiohook logs and delivers nothing - the features degrade.
    hookRunning = true;
    module.uIOhook.start();
  }
}

function detach(module: UiohookModule, subscription: AttachedSubscription): void {
  if (!attachedSubscriptions.delete(subscription)) {
    return;
  }
  const { handlers } = subscription;
  if (handlers.keydown) {
    module.uIOhook.removeListener("keydown", handlers.keydown as UiohookListener);
  }
  if (handlers.keyup) {
    module.uIOhook.removeListener("keyup", handlers.keyup as UiohookListener);
  }
  if (handlers.wheel) {
    module.uIOhook.removeListener("wheel", handlers.wheel as UiohookListener);
  }
  if (attachedSubscriptions.size === 0 && hookRunning) {
    hookRunning = false;
    try {
      module.uIOhook.stop();
    } catch (error) {
      console.error("[lune] failed to stop the global input hook:", error);
    }
  }
}

/**
 * Subscribes to the shared global input hook. `buildHandlers` runs once the native module
 * has loaded (it receives the module surface, e.g. the keycode table, to build its
 * handlers with) and its handlers stay attached until the returned disposer is called.
 * The hook itself starts with the first live subscription and stops with the last. Safe
 * to call before/while the module loads, and safe to dispose at any time (including
 * before the load resolves - the handlers are then never attached).
 */
export function subscribeGlobalInput(
  buildHandlers: (module: UiohookModuleSurface) => GlobalInputHandlers,
): () => void {
  let disposed = false;
  let attachedTo: { module: UiohookModule; subscription: AttachedSubscription } | null = null;

  void loadModule().then((module) => {
    if (module === null || disposed) {
      return;
    }
    const subscription: AttachedSubscription = { handlers: buildHandlers(module) };
    attachedTo = { module, subscription };
    attach(module, subscription);
  });

  return () => {
    disposed = true;
    if (attachedTo !== null) {
      detach(attachedTo.module, attachedTo.subscription);
      attachedTo = null;
    }
  };
}
