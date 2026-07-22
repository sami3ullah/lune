// @lune/shared is the single source of truth for the Shell<->Core IPC contract.
// Every message crossing the Electron main <-> renderer boundary (and, later, any
// HTTP adapter fronting the Core) is described here by a zod schema so the boundary
// cannot drift silently (developer story 46).
export * from "./ipc";
