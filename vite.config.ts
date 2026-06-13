import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [wasm(), topLevelAwait(), ...react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : {
          // Disable the Vite error overlay — WASM fetch errors are caught
          // gracefully by the collab layer; the overlay just blocks the UI.
          overlay: false,
        },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Pre-bundle the React runtime so the dev server doesn't have to scan
  // and re-bundle on the first import — noticeable on cold `tauri dev`
  // starts. Codicons CSS is small and pre-bundling avoids a second pass
  // when any component first pulls it in.
  // loro-crdt ships WASM — it must be excluded from esbuild pre-bundling
  // and handled entirely by vite-plugin-wasm.
  optimizeDeps: {
    exclude: ["loro-crdt"],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
    ],
    // Tell esbuild (used during pre-bundling) to treat .wasm files as
    // empty modules — prevents "ESM WASM proposal not supported" errors
    // when scanning transitive deps.
    esbuildOptions: {
      plugins: [{
        name: "wasm-stub",
        setup(build) {
          build.onLoad({ filter: /\.wasm$/ }, () => ({
            contents: "export default undefined",
          }));
        },
      }],
    },
  },

  // Resolve `loro-crdt` to its browser entry — uses `new URL(...)` +
  // synchronous XHR to load WASM, which Vite handles correctly without
  // the ESM WASM proposal that triggers the vite dev server error.
  resolve: {
    alias: {
      "loro-crdt": "loro-crdt/browser",
    },
  },

  // Serve .wasm files as static assets (needed for loro-crdt browser entry).
  assetsInclude: ["**/*.wasm"],

  // Tauri ships its own WebView2 / WKWebView, so we can safely target a
  // modern ES baseline. This lets esbuild skip a chunk of legacy
  // transforms / polyfills and produces smaller, faster bundles.
  // esnext required for top-level await (loro-crdt WASM initialisation)
  build: {
    target: "esnext",
    // Cut sourcemap cost from prod builds (Tauri release builds run
    // through tsc + vite build before signing — sourcemaps can double
    // the pipeline time on a cold cache).
    sourcemap: false,
    // esbuild minify is ~10x faster than terser for our bundle size and
    // produces output that's within a few % of terser.
    minify: "esbuild" as const,
    // Skip the gzip-size report — just a small dev-time speed win.
    reportCompressedSize: false,
  },

  // Match the dev-server compile target so HMR and prod builds use the
  // same lowering rules (avoids "works in dev, breaks in prod" surprises).
  esbuild: {
    target: "esnext",
  },

  // Required for vite-plugin-wasm when workers import WASM modules.
  worker: {
    format: "es" as const,
    plugins: () => [wasm()],
  },
}));
