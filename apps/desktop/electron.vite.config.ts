import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// electron-vite discovers the three entry points by convention:
//   main    -> src/main/index.ts
//   preload -> src/preload/index.ts
//   renderer-> src/renderer/index.html
//
// The workspace Core and shared packages ship TypeScript source (their package
// exports point at src/*.ts), so they must NOT be externalized in the main/preload
// bundles - otherwise a runtime require would hit un-transpiled .ts. Excluding them
// tells electron-vite to bundle them from source instead. Every other dependency
// stays externalized so native modules resolve from node_modules at runtime.
export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ["@lune/core", "@lune/shared"] }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@lune/shared"] })],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
