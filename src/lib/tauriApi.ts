import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FileNode } from "../state/types";

// ── Backend types (matching Rust structs) ──

export interface BackendFileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: BackendFileNode[];
}

export interface GraphNodeData {
  id: string;
  label: string;
  path: string;
}

export interface GraphEdgeData {
  source: string;
  target: string;
}

export interface VaultGraphData {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}

export interface BacklinkSnippet {
  source_path: string;
  source_name: string;
  snippet: string;
  line_number: number;
}

export interface BacklinksResult {
  linked: BacklinkSnippet[];
  unlinked: BacklinkSnippet[];
}

// ── Tauri command wrappers ──

export async function pickVaultFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Vault Folder",
  });
  return selected as string | null;
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_file", { path, content });
}

export async function listDirectory(path: string): Promise<BackendFileNode[]> {
  return invoke<BackendFileNode[]>("list_directory", { path });
}

export async function createFile(path: string): Promise<void> {
  return invoke<void>("create_file", { path });
}

export async function createFolder(path: string): Promise<void> {
  return invoke<void>("create_folder", { path });
}

export async function renameEntry(oldPath: string, newPath: string): Promise<void> {
  await invoke("rename_entry", { oldPath, newPath });
}

export async function deleteFile(path: string): Promise<void> {
  return invoke<void>("delete_file", { path });
}

export async function deleteFolder(path: string): Promise<void> {
  return invoke<void>("delete_folder", { path });
}

export async function openNewWindow(): Promise<void> {
  return invoke<void>("open_new_window");
}

export async function getVaultGraph(path: string): Promise<VaultGraphData> {
  return invoke<VaultGraphData>("get_vault_graph", { path });
}

export async function getBacklinks(vaultPath: string, activeFilePath: string): Promise<BacklinksResult> {
  return invoke<BacklinksResult>("get_backlinks", { vaultPath, activeFilePath });
}

// ── Converter: backend tree → lattice FileNode tree ──

/**
 * Converts the backend's FileNode shape (name, path, isDir, children)
 * to lattice's FileNode shape (id, name, kind, children).
 *
 * Uses the absolute path as the `id` — this is the canonical identity
 * for real filesystem files. The split-tree and tab system are id-agnostic,
 * so this works seamlessly.
 */
export function toFrontendTree(backendNodes: BackendFileNode[]): FileNode[] {
  return backendNodes.map((node) => {
    const kind = node.isDir
      ? "folder" as const
      : node.name.endsWith(".canvas")
        ? "canvas" as const
        : "file" as const;

    const result: FileNode = {
      id: node.path, // absolute path IS the identity
      name: node.name,
      kind,
    };

    if (node.children) {
      result.children = toFrontendTree(node.children);
    }

    return result;
  });
}
