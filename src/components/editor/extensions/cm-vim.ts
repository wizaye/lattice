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

  // Register ex commands once
  try {
    Vim.defineEx("hint",  "hint",  () => window.dispatchEvent(new CustomEvent("lattice-hint-mode")));
    Vim.defineEx("hints", "hints", () => window.dispatchEvent(new CustomEvent("lattice-hint-mode")));
    Vim.defineEx("whichkey", "whichkey", () => window.dispatchEvent(new CustomEvent("lattice-open-whichkey")));
    Vim.defineEx("help", "help", () => window.dispatchEvent(new CustomEvent("lattice-open-shortcuts")));
    Vim.defineEx("keys", "keys", () => window.dispatchEvent(new CustomEvent("lattice-open-shortcuts")));
    
    // Map uppercase F in normal mode to hint mode
    Vim.map("F", ":hint<CR>", "normal");
    // Map space to open which-key cheatsheet
    Vim.map("<Space>", ":whichkey<CR>", "normal");
    // Map ? to open shortcuts cheatsheet
    Vim.map("?", ":help<CR>", "normal");
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
