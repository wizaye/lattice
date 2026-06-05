import { useVaultStore } from "../state/vaultStore";
import type { FileNode } from "../state/types";

/**
 * Builds a map of all markdown files in the vault.
 * Keys are the base file name (e.g., 'test2').
 * Values are an array of absolute paths that have this name (e.g., ['/Users/vault/test2.md', '/Users/vault/folder/test2.md']).
 */
export function buildFileMap(): Map<string, string[]> {
  const tree = useVaultStore.getState().fileTree;
  const map = new Map<string, string[]>();

  const traverse = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.kind === "folder") {
        if (node.children) {
          traverse(node.children);
        }
      } else if (node.name.toLowerCase().endsWith(".md")) {
        const baseName = node.name.slice(0, -3); // remove .md
        const existing = map.get(baseName) || [];
        existing.push(node.id);
        map.set(baseName, existing);
      }
    }
  };

  traverse(tree);
  return map;
}

/**
 * Given an absolute path to a markdown file, computes the shortest unique path
 * that unambiguously identifies it within the vault.
 * 
 * Example:
 * If we only have `/vault/test.md`, getShortestUniquePath('/vault/test.md') => 'test'
 * If we have `/vault/test.md` and `/vault/folder/test.md`:
 *   getShortestUniquePath('/vault/folder/test.md') => 'folder/test'
 */
export function getShortestUniquePath(absolutePath: string): string {
  const vaultPath = useVaultStore.getState().vaultPath;
  if (!vaultPath) return absolutePath; // Should not happen in practice

  const map = buildFileMap();
  
  // Extract filename without .md
  const fileNameWithExt = absolutePath.split("/").pop() || "";
  if (!fileNameWithExt.endsWith(".md")) return absolutePath; // Not a markdown file

  const baseName = fileNameWithExt.slice(0, -3);
  const duplicates = map.get(baseName);

  // If there's only one file with this name, the basename is unique
  if (!duplicates || duplicates.length <= 1) {
    return baseName;
  }

  // If there are duplicates, we need to prepend parent directories until it's unique
  // Get relative path parts
  const relPath = absolutePath.slice(vaultPath.length).replace(/^\//, "");
  const relParts = relPath.slice(0, -3).split("/"); // without .md

  // Start checking from the end (just basename), then add parents one by one
  for (let i = 1; i <= relParts.length; i++) {
    const candidatePath = relParts.slice(-i).join("/");
    
    // Check if this candidate uniquely identifies the path among the duplicates
    const matches = duplicates.filter(dupPath => {
      const dupRelPath = dupPath.slice(vaultPath.length).replace(/^\//, "").slice(0, -3);
      return dupRelPath.endsWith(candidatePath) && 
             (dupRelPath === candidatePath || dupRelPath.endsWith("/" + candidatePath));
    });

    if (matches.length === 1) {
      return candidatePath;
    }
  }

  // Fallback to full relative path without extension
  return relParts.join("/");
}

/**
 * Given a potential link target (e.g. 'test', 'folder/test'), 
 * resolves it to the absolute path if it exists.
 */
export function resolveLinkToPath(target: string): string | null {
  const map = buildFileMap();
  const vaultPath = useVaultStore.getState().vaultPath;
  if (!vaultPath) return null;

  // Split target by / to get the basename
  const parts = target.split("/");
  const baseName = parts[parts.length - 1];

  const candidates = map.get(baseName);
  if (!candidates || candidates.length === 0) return null;

  if (candidates.length === 1) {
    // If we only have one match for the basename, just use it (even if they specified some folder path)
    // Obsidian favors exact path matches, but if there's only one basename match it works too.
    return candidates[0];
  }

  // Multiple candidates, find the one that matches the provided path suffix
  for (const candidate of candidates) {
    const candidateRelPath = candidate.slice(vaultPath.length).replace(/^\//, "").slice(0, -3);
    
    if (candidateRelPath === target || candidateRelPath.endsWith("/" + target)) {
      return candidate;
    }
  }

  // If still ambiguous and no perfect suffix match, just return the first one (fallback)
  return candidates[0];
}
