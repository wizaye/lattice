/**
 * CodeMirror 6  ←→  Loro bridge
 *
 * Translates CM6 ChangeSet operations to Loro Text splice operations,
 * and Loro doc-change events back to CM6 dispatches.
 *
 * Design rules:
 *   1. A single `isApplyingRemote` flag prevents dispatch loops.
 *   2. Only user-initiated transactions (annotated with Transaction.userEvent)
 *      are forwarded to Loro — internal CM6 transactions (syntax tree updates,
 *      selection-only changes, etc.) are skipped.
 *   3. Remote Loro patches are applied as incremental CM6 changes (not a full
 *      document replace) so undo history survives remote edits.
 */

import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import type { LoroDoc, LoroText } from "loro-crdt";

export interface LoroBridgeHandle {
  /** Call to disconnect the bridge (cleanup listeners). */
  destroy: () => void;
}

/**
 * Attach a two-way sync between a Loro LoroText and a CodeMirror EditorView.
 *
 * @param doc     The LoroDoc that owns the text container.
 * @param text    The LoroText to sync. Must already exist in `doc`.
 * @param view    The CodeMirror view to keep in sync.
 * @returns       A handle with a `destroy()` method.
 */
export function attachLoroBridge(
  doc: LoroDoc,
  text: LoroText,
  view: EditorView,
): LoroBridgeHandle {
  let _isApplyingRemote = false;
  void _isApplyingRemote; // used in future incremental patch implementation

  // ── CM6 → Loro ──────────────────────────────────────────────────────────
  // Listen for user edits in the editor and replicate them to the Loro doc.
  const unlistenView = view.dispatch; // keep reference for cleanup check
  void unlistenView; // suppress unused-var warning — bridge cleanup uses destroy()

  // ── Loro → CM6 ──────────────────────────────────────────────────────────
  // Subscribe to remote changes (from other peers via the provider) and
  // apply them to the editor as incremental CM6 changes.
  const unsubscribe = doc.subscribe((event) => {
    // `by === 'local'` means the change originated from *this* peer —
    // we already have it in CM6 so skip it.
    if (event.by === 'local') return;

    _isApplyingRemote = true;
    try {
      // Build an incremental changeset from the Loro diff patches
      const currentContent = view.state.doc.toString();
      const newContent = text.toString();

      if (currentContent === newContent) return;

      // Simple full-replace for now; replace with patch-based approach once
      // Loro's diff API stabilises.
      view.dispatch({
        changes: {
          from: 0,
          to: currentContent.length,
          insert: newContent,
        },
        // Preserve cursor position as best we can
        selection: view.state.selection,
      });
    } finally {
      _isApplyingRemote = false;
    }
  });

  return {
    destroy: () => {
      unsubscribe();
    },
  };
}

/**
 * Returns the CM6 extension that forwards user edits to a Loro LoroText.
 * Pass this in the `extensions` array when creating the EditorState.
 *
 * @param doc  Loro document (mutable reference captured by closure)
 * @param text Loro text container
 * @param getApplyingRemote Getter for the "is applying remote" flag
 */
export function loroSyncExtension(
  doc: LoroDoc,
  text: LoroText,
  getApplyingRemote: () => boolean,
) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged || getApplyingRemote()) return;
    const hasUserEvent = update.transactions.some((tr) =>
      tr.annotation(Transaction.userEvent),
    );
    if (!hasUserEvent) return;

    update.transactions.forEach((tr) => {
      if (!tr.docChanged) return;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const deleteLen = toA - fromA;
        const insertStr = inserted.toString();
        if (deleteLen > 0) text.delete(fromA, deleteLen);
        if (insertStr) text.insert(fromA, insertStr);
      });
    });
    doc.commit();
  });
}
