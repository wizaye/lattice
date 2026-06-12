/**
 * LoroProvider — local-only Loro-backed CollabProvider.
 *
 * Phase 1: single user, no network. The Loro document lives in memory
 * and is serialized to/from the plain `.md` file on disk.
 *
 * Phase 2 (later): attach a WebSocket transport adapter and the same
 * provider works multi-user — no changes needed at the editor layer.
 *
 * Why Loro?
 *  • Rust-native (same crate used in the Tauri backend)
 *  • Fugue algorithm — best-in-class text CRDT semantics (no interleaving)
 *  • Built-in version control / time travel
 *  • Rich text CRDT (bold, links survive concurrent edits natively)
 *
 * WASM loading: loro-crdt ships a WASM binary. We import it lazily via a
 * dynamic import so the module is only loaded when collaboration is enabled,
 * keeping the initial bundle small.
 */

import type { LoroDoc } from "loro-crdt";
import type { EditorView } from "@codemirror/view";
import type { CollabProvider, CollabState, CollabUser } from "./types";
import { loroSyncExtension } from "./loro-bridge";

// ─── Lazy WASM loader ──────────────────────────────────────────────────────

let _LoroDoc: typeof LoroDoc | null = null;

async function getLoroDoc(): Promise<typeof LoroDoc> {
  if (_LoroDoc) return _LoroDoc;
  const mod = await import("loro-crdt");
  _LoroDoc = mod.LoroDoc;
  return _LoroDoc;
}

/** Create a LoroDoc instance (async — waits for WASM to load). */
export async function createLoroDoc(): Promise<LoroDoc> {
  const Doc = await getLoroDoc();
  return new Doc();
}

/** Generate a stable random hex colour for a peer */
function peerColor(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue},70%,55%)`;
}

/** Generate a random UUID-ish peer ID */
function peerIdFor(docId: string): string {
  // Stable per (docId + session) — stored in sessionStorage
  const key = `lattice.collab.peerId.${docId}`;
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

export class LoroProvider implements CollabProvider {
  readonly docId: string;

  private _doc: LoroDoc | null = null;
  private _docReady: Promise<LoroDoc>;
  private _peerId: string;
  private _localUser: CollabUser;
  private _state: CollabState;
  private _subscribers: Array<(state: CollabState) => void> = [];
  private _isApplyingRemote = false;
  private _boundView: EditorView | null = null;
  private _unsubscribeLoro: (() => void) | null = null;

  constructor(docId: string, userName = "You") {
    this.docId = docId;
    this._peerId = peerIdFor(docId);
    this._localUser = {
      peerId: this._peerId,
      name: userName,
      color: peerColor(),
    };
    this._state = {
      connected: false,
      peerCount: 0,
      cursors: new Map(),
    };
    // Pre-warm the WASM load in the background
    this._docReady = createLoroDoc().then((doc) => {
      this._doc = doc;
      return doc;
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  getState(): CollabState {
    return this._state;
  }

  onStateChange(cb: (state: CollabState) => void): () => void {
    this._subscribers.push(cb);
    return () => {
      this._subscribers = this._subscribers.filter((s) => s !== cb);
    };
  }

  updateCursor(anchor: number, head: number): void {
    // Phase 1: no-op (no peers to broadcast to)
    // Phase 2: send cursor update over WebSocket
    void anchor;
    void head;
  }

  bind(view: EditorView): () => void {
    this._boundView = view;
    let cancelled = false;

    // Async: wait for WASM to load, then set up the sync
    this._docReady.then((doc) => {
      if (cancelled || !this._boundView) return;

      const text = doc.getText("content");

      // Seed the Loro doc from the current editor content if empty
      const existingText = text.toString();
      const editorContent = view.state.doc.toString();
      if (!existingText && editorContent) {
        text.insert(0, editorContent);
        doc.commit();
      } else if (existingText && existingText !== editorContent) {
        this._isApplyingRemote = true;
        view.dispatch({
          changes: { from: 0, to: editorContent.length, insert: existingText },
        });
        this._isApplyingRemote = false;
      }

      // Subscribe to Loro changes (remote peers in Phase 2)
      this._unsubscribeLoro = doc.subscribe((event) => {
        if (event.by === 'local') return;
        if (!this._boundView) return;

        this._isApplyingRemote = true;
        try {
          const current = this._boundView.state.doc.toString();
          const updated = text.toString();
          if (current !== updated) {
            this._boundView.dispatch({
              changes: { from: 0, to: current.length, insert: updated },
              selection: this._boundView.state.selection,
            });
          }
        } finally {
          this._isApplyingRemote = false;
        }
      });
    }).catch((err) => {
      console.warn("[lattice-collab] Loro WASM failed to load:", err);
    });

    return () => {
      cancelled = true;
      this._unsubscribeLoro?.();
      this._boundView = null;
    };
  }

  /**
   * Get the CM6 extension that must be included in the editor's extension array.
   * If the Loro doc isn't loaded yet, returns an empty extension (no-op).
   */
  getCM6Extension() {
    // If doc not ready yet, return an empty array — the extension will be
    // added on the next editor rebuild once WASM is loaded.
    if (!this._doc) return [];
    const text = this._doc.getText("content");
    return loroSyncExtension(
      this._doc,
      text,
      () => this._isApplyingRemote,
    );
  }

  /**
   * Export the current Loro document state as binary (Uint8Array).
   */
  export(): Uint8Array | null {
    return this._doc ? this._doc.export({ mode: "snapshot" }) : null;
  }

  /**
   * Load a previously exported binary snapshot into this provider.
   * Call before `bind()` or await `_docReady` first.
   */
  import(bytes: Uint8Array): void {
    this._docReady.then((doc) => doc.import(bytes));
  }

  /**
   * Get the current document content as a plain string.
   */
  getContent(): string {
    return this._doc ? this._doc.getText("content").toString() : "";
  }

  destroy(): void {
    this._unsubscribeLoro?.();
    this._boundView = null;
    this._subscribers = [];
    this._doc = null;
  }

  // Expose peer info for the status indicator
  get localUser(): CollabUser {
    return this._localUser;
  }
}
