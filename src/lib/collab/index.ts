/**
 * Collab layer public exports.
 *
 * Usage:
 *   import { LoroProvider } from '../lib/collab';
 *
 * The provider is created per open document, lives as long as the tab is open,
 * and is destroyed when the tab is closed.
 *
 * Phase 1: LoroProvider (local-only CRDT, no network)
 * Phase 2: Add a WebSocket transport adapter to LoroProvider
 * Phase 3: Add P2P WebRTC adapter for direct peer connections
 */

export { LoroProvider } from "./loro-provider";
export type { CollabProvider, CollabUser, CollabCursor, CollabState } from "./types";
