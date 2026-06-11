import { vim } from "@replit/codemirror-vim";
import { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * Vim mode extension for CodeMirror
 */
export function vimMode(enabled: boolean): Extension[] {
  if (!enabled) {
    return [];
  }

  return [
    vim(),
    // Custom key mappings for common Lattice operations
    keymap.of([
      {
        key: "Ctrl-s",
        run: () => {
          // Save handled by parent component
          return false;
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
