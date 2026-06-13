import { vim, Vim } from "@replit/codemirror-vim";
import { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * Vim mode extension for CodeMirror.
 *
 * Custom ex commands registered here:
 *   :hint   — activates Vimium-style hint mode (same as Ctrl+Shift+F)
 *   :hints  — alias
 *
 * Custom normal-mode map:
 *   F       — activates hint mode without conflicting with vim's own `f{char}`
 */
export function vimMode(enabled: boolean): Extension[] {
  if (!enabled) {
    return [];
  }

  // Register :hint ex command once
  try {
    Vim.defineEx("hint",  "hint",  () => window.dispatchEvent(new CustomEvent("lattice-hint-mode")));
    Vim.defineEx("hints", "hints", () => window.dispatchEvent(new CustomEvent("lattice-hint-mode")));
    // Map uppercase F in normal mode to hint mode
    // (lowercase f is already "find char" in vim)
    // Note: Ctrl+Shift+H is the global shortcut; F gives the same in vim normal
    Vim.map("F", ":hint<CR>", "normal");
  } catch {
    // Already registered (HMR) — ignore
  }

  return [
    vim(),
    keymap.of([
      {
        key: "Ctrl-s",
        run: () => {
          return false; // Save handled by parent
        },
      },
    ]),
  ];
}

/**
 * Get Vim mode status
 */
export function getVimStatus(view: EditorView): string {
  const vimState = (view.state as any).vim;
  if (!vimState) return "normal";
  return vimState.mode || "normal";
}
