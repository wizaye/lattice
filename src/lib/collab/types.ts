/**
 * Collaboration types — transport-agnostic interfaces.
 *
 * The design follows a provider pattern (same as Yjs) so we can swap
 * the backing store (local-only Loro → Loro+WebSocket → Loro+WebRTC)
 * without touching the editor.
 */

export interface CollabUser {
  /** Unique peer ID (UUID generated once per session) */
  peerId: string;
  /** Display name (from settings or OS user) */
  name: string;
  /** Hex colour for cursor/selection highlighting */
  color: string;
}

export interface CollabCursor {
  peerId: string;
  user: CollabUser;
  /** CM6 cursor anchor position */
  anchor: number;
  /** CM6 selection head position (= anchor when no selection) */
  head: number;
}

export interface CollabState {
  /** Whether this provider is currently syncing with peers */
  connected: boolean;
  /** Number of connected peers (0 = local-only) */
  peerCount: number;
  /** Remote cursors, keyed by peerId */
  cursors: Map<string, CollabCursor>;
}

export interface CollabProvider {
  /** Document identifier (typically the vault-relative path) */
  docId: string;

  /** Current state (reactive — read via getState()) */
  getState(): CollabState;

  /**
   * Bind this provider to a CodeMirror EditorView.
   * Returns a cleanup function to call on unmount.
   */
  bind(view: import("@codemirror/view").EditorView): () => void;

  /**
   * Notify the provider that the local cursor/selection changed.
   * Broadcast to peers if connected.
   */
  updateCursor(anchor: number, head: number): void;

  /** Subscribe to state changes (connected, peerCount, cursors). */
  onStateChange(cb: (state: CollabState) => void): () => void;

  /** Gracefully disconnect and release all resources. */
  destroy(): void;
}
