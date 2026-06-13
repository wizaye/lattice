/**
 * Lattice Protocol Handler
 * Handles lattice:// deep links
 * 
 * Supported URLs:
 * - lattice://open?note=Note%20Name
 * - lattice://daily
 * - lattice://capture?text=Quick%20note
 * - lattice://search?q=query
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface ProtocolParams {
  action: 'open' | 'daily' | 'capture' | 'search';
  note?: string;
  text?: string;
  q?: string;
}

export function parseProtocolUrl(url: string): ProtocolParams | null {
  if (!url.startsWith('lattice://')) {
    return null;
  }

  const urlObj = new URL(url);
  const action = urlObj.hostname as ProtocolParams['action'];
  const params = new URLSearchParams(urlObj.search);

  return {
    action,
    note: params.get('note') || undefined,
    text: params.get('text') || undefined,
    q: params.get('q') || undefined,
  };
}

export async function handleProtocolUrl(url: string): Promise<void> {
  const params = parseProtocolUrl(url);
  if (!params) {
    console.error('Invalid protocol URL:', url);
    return;
  }

  const appWindow = getCurrentWebviewWindow();

  // Bring window to front
  await appWindow.show();
  await appWindow.setFocus();

  switch (params.action) {
    case 'open':
      if (params.note) {
        // Open specific note
        console.log('Opening note:', params.note);
        // Emit event to open note
        window.dispatchEvent(new CustomEvent('lattice:open-note', {
          detail: { noteName: params.note }
        }));
      }
      break;

    case 'daily':
      // Open today's daily note
      console.log('Opening daily note');
      window.dispatchEvent(new CustomEvent('lattice:open-daily'));
      break;

    case 'capture':
      if (params.text) {
        // Quick capture
        try {
          const result = await invoke('create_note', {
            folder: 'inbox',
            title: null,
            content: params.text,
            tags: [],
          });
          console.log('Captured:', result);
        } catch (e) {
          console.error('Failed to capture:', e);
        }
      }
      break;

    case 'search':
      if (params.q) {
        // Trigger search
        console.log('Searching for:', params.q);
        window.dispatchEvent(new CustomEvent('lattice:search', {
          detail: { query: params.q }
        }));
      }
      break;

    default:
      console.error('Unknown action:', params.action);
  }
}

// Register protocol handler on app start
export function registerProtocolHandler() {
  if ((window as any).__TAURI__) {
    // Listen for deep link events from Tauri
    const appWindow = getCurrentWebviewWindow();
    
    appWindow.listen('lattice-protocol', (event) => {
      const url = (event.payload as any).url;
      if (url) {
        handleProtocolUrl(url);
      }
    });
  }
}
