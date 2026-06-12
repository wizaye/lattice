import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FileNode } from "../state/types";

/**
 * Returns true when running inside a Tauri window (desktop app).
 * Returns false when served as a plain web page (browser mode / Vite dev).
 * Gate every `invoke` call with this to prevent "IPC not found" crashes.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" &&
    !!(window as any).__TAURI_INTERNALS__;
}

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
  nodeType: string;
  taskStatus?: string;
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
  if (!isTauri()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Vault Folder",
  });
  return selected as string | null;
}

export async function readFile(path: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("read_file", { path });
}

/**
 * Read a binary file (e.g. `.pdf`) as a `Uint8Array`.
 *
 * The Tauri command (`read_file_bytes`) returns a `Vec<u8>` which the
 * `@tauri-apps/api/core` IPC layer ships as a JS `number[]` over the
 * v2 wire format.  We immediately wrap it in a typed array so call
 * sites can hand it to pdfjs / Blob without further conversion.
 *
 * Falls back to `null` when called against the mock vault sentinel
 * (no real filesystem path to read from) so consumers can branch on
 * `result ?? base64Source` without try/catch noise.
 */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  if (!isTauri()) return new Uint8Array();
  const raw = await invoke<number[] | ArrayBuffer | Uint8Array>(
    "read_file_bytes",
    { path },
  );
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw as number[]);
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("write_file", { path, content });
}

export async function listDirectory(path: string): Promise<BackendFileNode[]> {
  if (!isTauri()) return [];
  return invoke<BackendFileNode[]>("list_directory", { path });
}

export async function createFile(path: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("create_file", { path });
}

export async function createFolder(path: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("create_folder", { path });
}

export async function renameEntry(oldPath: string, newPath: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("rename_entry", { oldPath, newPath });
}

export async function deleteFile(path: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("delete_file", { path });
}

export async function deleteFolder(path: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("delete_folder", { path });
}

export async function openNewWindow(): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("open_new_window");
}

export async function getVaultGraph(path: string): Promise<VaultGraphData> {
  if (!isTauri()) return { nodes: [], edges: [] };
  return invoke<VaultGraphData>("get_vault_graph", { path });
}

export async function getBacklinks(vaultPath: string, activeFilePath: string): Promise<BacklinksResult> {
  if (!isTauri()) return { linked: [], unlinked: [] };
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
    // Order matters: folder check first (it has no extension at all),
    // then specific extensions, then the markdown/text default.  We
    // route `.pdf` to its own `kind` because PdfView reads the file
    // as binary bytes — the markdown editor's text path would
    // mojibake the body and the dirty-tracker would mark it dirty on
    // first paint.
    const lower = node.name.toLowerCase();
    const kind = node.isDir
      ? ("folder" as const)
      : lower.endsWith(".canvas")
        ? ("canvas" as const)
        : lower.endsWith(".pdf")
          ? ("pdf" as const)
          : ("file" as const);

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
