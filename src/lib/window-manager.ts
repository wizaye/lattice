/**
 * Window and Pane Management System
 * Supports multi-window, split panes, and detached windows
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export type PaneLayout = 'single' | 'horizontal' | 'vertical' | 'grid';

export interface Pane {
  id: string;
  type: 'editor' | 'preview' | 'graph' | 'canvas' | 'calendar' | 'files';
  path?: string; // For editor/preview
  title?: string;
  size?: number; // Percentage for split panes
}

export interface WindowConfig {
  id: string;
  label: string;
  title: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  panes: Pane[];
  layout: PaneLayout;
}

/**
 * Create a new detached window
 */
export async function createWindow(config: WindowConfig): Promise<WebviewWindow> {
  const webview = new WebviewWindow(config.label, {
    title: config.title,
    width: config.width,
    height: config.height,
    x: config.x,
    y: config.y,
    center: !config.x && !config.y,
    decorations: true,
    resizable: true,
    url: `/window.html?id=${config.id}&panes=${encodeURIComponent(JSON.stringify(config.panes))}&layout=${config.layout}`,
  });

  await webview.once('tauri://created', () => {
    console.log('Window created:', config.label);
  });

  await webview.once('tauri://error', (e) => {
    console.error('Window creation error:', e);
  });

  return webview;
}

/**
 * Open note in new window
 */
export async function openNoteInNewWindow(notePath: string, noteTitle: string): Promise<void> {
  const config: WindowConfig = {
    id: `note-${Date.now()}`,
    label: `note-${notePath.replace(/[^a-zA-Z0-9]/g, '-')}`,
    title: `${noteTitle} - Lattice`,
    width: 900,
    height: 700,
    panes: [
      {
        id: 'pane-1',
        type: 'editor',
        path: notePath,
        title: noteTitle,
      },
    ],
    layout: 'single',
  };

  await createWindow(config);
}

/**
 * Open split view in new window
 */
export async function openSplitViewWindow(
  leftPath: string,
  rightPath: string,
  leftTitle: string,
  rightTitle: string
): Promise<void> {
  const config: WindowConfig = {
    id: `split-${Date.now()}`,
    label: `split-${Date.now()}`,
    title: `${leftTitle} | ${rightTitle} - Lattice`,
    width: 1400,
    height: 800,
    panes: [
      {
        id: 'pane-left',
        type: 'editor',
        path: leftPath,
        title: leftTitle,
        size: 50,
      },
      {
        id: 'pane-right',
        type: 'editor',
        path: rightPath,
        title: rightTitle,
        size: 50,
      },
    ],
    layout: 'horizontal',
  };

  await createWindow(config);
}

/**
 * Open reference pane (pinned preview)
 */
export async function openReferencePane(notePath: string, noteTitle: string): Promise<void> {
  const config: WindowConfig = {
    id: `ref-${Date.now()}`,
    label: `reference-${notePath.replace(/[^a-zA-Z0-9]/g, '-')}`,
    title: `📌 ${noteTitle} - Lattice`,
    width: 600,
    height: 800,
    panes: [
      {
        id: 'pane-1',
        type: 'preview',
        path: notePath,
        title: noteTitle,
      },
    ],
    layout: 'single',
  };

  await createWindow(config);
}

/**
 * Open graph in new window
 */
export async function openGraphWindow(): Promise<void> {
  const config: WindowConfig = {
    id: `graph-${Date.now()}`,
    label: `graph-window`,
    title: 'Graph View - Lattice',
    width: 1200,
    height: 800,
    panes: [
      {
        id: 'pane-1',
        type: 'graph',
      },
    ],
    layout: 'single',
  };

  await createWindow(config);
}

/**
 * Open canvas in new window
 */
export async function openCanvasWindow(canvasPath?: string): Promise<void> {
  const config: WindowConfig = {
    id: `canvas-${Date.now()}`,
    label: `canvas-window`,
    title: 'Canvas - Lattice',
    width: 1400,
    height: 900,
    panes: [
      {
        id: 'pane-1',
        type: 'canvas',
        path: canvasPath,
      },
    ],
    layout: 'single',
  };

  await createWindow(config);
}

/**
 * Get all open windows
 */
export async function getAllWindows(): Promise<WebviewWindow[]> {
  return WebviewWindow.getAll();
}

/**
 * Close window by label
 */
export async function closeWindow(label: string): Promise<void> {
  const windows = await getAllWindows();
  const target = windows.find((w) => w.label === label);
  if (target) {
    await target.close();
  }
}

/**
 * Focus window by label
 */
export async function focusWindow(label: string): Promise<void> {
  const windows = await getAllWindows();
  const target = windows.find((w) => w.label === label);
  if (target) {
    await target.setFocus();
  }
}

/**
 * Tile windows (arrange all open windows)
 */
export async function tileWindows(): Promise<void> {
  const windows = await getAllWindows();
  const screenWidth = window.screen.availWidth;
  const screenHeight = window.screen.availHeight;

  if (windows.length === 1) {
    return;
  }

  // Simple tiling: split screen horizontally
  const windowWidth = Math.floor(screenWidth / windows.length);

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    await w.setSize({ width: windowWidth, height: screenHeight });
    await w.setPosition({ x: i * windowWidth, y: 0 });
  }
}
