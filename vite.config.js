var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error process is a nodejs global
var host = process.env.TAURI_DEV_HOST;
// https://vite.dev/config/
export default defineConfig(function () { return ({
    plugins: __spreadArray([], react(), true),
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
                host: host,
                port: 1421,
            }
            : undefined,
        watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
        },
    },
    // Pre-bundle the React runtime so the dev server doesn't have to scan
    // and re-bundle on the first import — noticeable on cold `tauri dev`
    // starts. Codicons CSS is small and pre-bundling avoids a second pass
    // when any component first pulls it in.
    optimizeDeps: {
        include: [
            "react",
            "react-dom",
            "react-dom/client",
            "@vscode/codicons/dist/codicon.css",
        ],
    },
    // Tauri ships its own WebView2 / WKWebView, so we can safely target a
    // modern ES baseline. This lets esbuild skip a chunk of legacy
    // transforms / polyfills and produces smaller, faster bundles.
    build: {
        target: "es2022",
        // Cut sourcemap cost from prod builds (Tauri release builds run
        // through tsc + vite build before signing — sourcemaps can double
        // the pipeline time on a cold cache).
        sourcemap: false,
        // esbuild minify is ~10x faster than terser for our bundle size and
        // produces output that's within a few % of terser.
        minify: "esbuild",
        // Skip the gzip-size report — just a small dev-time speed win.
        reportCompressedSize: false,
    },
    // Match the dev-server compile target so HMR and prod builds use the
    // same lowering rules (avoids "works in dev, breaks in prod" surprises).
    esbuild: {
        target: "es2022",
    },
}); });
