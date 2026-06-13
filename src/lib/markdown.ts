import { useVaultStore } from "../state/vaultStore";
import type { FileNode } from "../state/types";
import { useEditorStore } from "../state/editorStore";
import { readFile, writeFile, renameEntry } from "./tauriApi";
import { getShortestUniquePath, resolveLinkToPath } from "./indexer";

/**
 * Replaces wikilinks in markdown content while skipping code blocks.
 * @param content The original markdown string
 * @param targetAbsolutePaths The absolute paths of the files that were renamed
 * @param getNewLink A function that returns the new link text given the old absolute path
 */
export function updateLinksInMarkdown(
  content: string,
  targetAbsolutePaths: string[],
  getNewLink: (oldAbsolutePath: string) => string | null
): { newContent: string; modified: boolean } {
  let newContent = "";
  let modified = false;

  // A simple state machine to skip code blocks
  let inFencedCodeBlock = false;
  let inInlineCode = false;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Toggle fenced code block
    if (line.trim().startsWith("```")) {
      inFencedCodeBlock = !inFencedCodeBlock;
      newContent += line + (i === lines.length - 1 ? "" : "\n");
      continue;
    }

    if (inFencedCodeBlock) {
      newContent += line + (i === lines.length - 1 ? "" : "\n");
      continue;
    }

    // Process line for inline code and links
    let newLine = "";
    let j = 0;
    while (j < line.length) {
      // Toggle inline code
      if (line[j] === "`") {
        inInlineCode = !inInlineCode;
        newLine += line[j];
        j++;
        continue;
      }

      if (!inInlineCode && line.substring(j, j + 2) === "[[") {
        const endIdx = line.indexOf("]]", j + 2);
        if (endIdx !== -1) {
          const innerText = line.substring(j + 2, endIdx);
          const parts = innerText.split("|");
          const linkTarget = parts[0];
          const displayText = parts.length > 1 ? parts.slice(1).join("|") : "";

          // Resolve the link target to see if it points to one of our renamed files
          const resolvedPath = resolveLinkToPath(linkTarget);
          
          if (resolvedPath && targetAbsolutePaths.includes(resolvedPath)) {
            const newLinkTarget = getNewLink(resolvedPath);
            if (newLinkTarget) {
              const newLinkText = displayText ? `${newLinkTarget}|${displayText}` : newLinkTarget;
              newLine += `[[${newLinkText}]]`;
              modified = true;
              j = endIdx + 2;
              continue;
            }
          }
          
          // No match, just output the link as-is
          newLine += `[[${innerText}]]`;
          j = endIdx + 2;
          continue;
        }
      }

      newLine += line[j];
      j++;
    }

    // Inline code spans cannot cross line boundaries in standard Markdown
    // (CommonMark spec §6.1: “backtick strings are on the same line”).
    // Reset the flag here so an unclosed backtick on line N doesn't
    // silently suppress wikilink processing on line N+1 (bug fix).
    inInlineCode = false;
    newContent += newLine + (i === lines.length - 1 ? "" : "\n");
  }

  return { newContent, modified };
}

/**
 * Renames a file or folder and updates all wikilinks in the vault.
 */
export async function renameAndUpdateLinks(oldPath: string, newPath: string): Promise<void> {
  const vaultStore = useVaultStore.getState();
  const editorStore = useEditorStore.getState();
  
  if (!vaultStore.vaultPath) throw new Error("Vault not open");
  
  // 1. Identify all markdown files that will be affected.
  // If it's a file, it's just oldPath. If it's a folder, it's all .md files inside it.
  const targetFiles: string[] = [];
  
  const collectTargetFiles = (node: FileNode, currentPath: string) => {
    if (node.kind !== "folder" && node.name.toLowerCase().endsWith(".md")) {
      targetFiles.push(currentPath);
    } else if (node.kind === "folder" && node.children) {
      for (const child of node.children) {
        // Construct the old absolute path for the child
        const childPath = currentPath + "/" + child.name;
        collectTargetFiles(child, childPath);
      }
    }
  };

  // Find the node in the tree to collect targets
  const findNode = (nodes: FileNode[], path: string): FileNode | null => {
    for (const n of nodes) {
      if (n.id === path) return n; // node.id is the path in lattice
      if (n.children) {
        const found = findNode(n.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const oldNode = findNode(vaultStore.fileTree, oldPath);
  if (oldNode) {
    collectTargetFiles(oldNode, oldPath);
  } else {
    // Fallback if not found in tree for some reason
    if (oldPath.toLowerCase().endsWith(".md")) {
      targetFiles.push(oldPath);
    }
  }

  // 2. We need to resolve all links in the vault *before* renaming,
  // but we also need the *new* shortest unique paths *after* renaming.
  // To do this smoothly:
  // - We will rename the file/folder on disk first.
  await renameEntry(oldPath, newPath);

  // - Update the vaultStore file tree so the indexer knows about the new paths.
  if (oldNode?.kind === "folder") {
    // It's a folder move
    vaultStore.refreshTree(); // Use refreshTree since lattice vaultStore lacks manual moveNodeInTree
  } else {
    vaultStore.refreshTree();
  }

  // - Now that the tree is updated, we can compute the new shortest unique paths for all target files.
  const newPathMappings = new Map<string, string>(); // old absolute path -> new shortest unique path
  for (const oldTargetPath of targetFiles) {
    // Calculate the new absolute path
    const newTargetPath = oldTargetPath.replaceAll(oldPath, newPath);
    // `replaceAll` fixes the first-occurrence-only bug: if `oldPath`
    // appears more than once in the absolute path (repeated dir name or
    // symlinked path), the previous `replace()` left later occurrences
    // intact, producing a broken new path.
    newPathMappings.set(oldTargetPath, getShortestUniquePath(newTargetPath));
  }

  // 3. Scan the entire vault and update links
  const allMdFiles: string[] = [];
  const collectAllMd = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.kind !== "folder" && node.name.toLowerCase().endsWith(".md")) {
        allMdFiles.push(node.id); // node.id is the absolute path
      } else if (node.children) {
        collectAllMd(node.children);
      }
    }
  };
  collectAllMd(vaultStore.fileTree);

  // 4. Update the links
  for (const file of allMdFiles) {
    try {
      // Check if file is open in editor and dirty
      let content = "";
      let fromEditor = false;
      
      const fileContent = editorStore.fileContents[file];
      if (fileContent !== undefined) {
        // Use in-memory content
        content = fileContent;
        fromEditor = true;
      } else {
        // Read from disk
        content = await readFile(file);
      }

      const { newContent, modified } = updateLinksInMarkdown(
        content,
        targetFiles,
        (oldAbsolutePath) => newPathMappings.get(oldAbsolutePath) || null
      );

      if (modified) {
        if (fromEditor) {
          // Update the editor store directly
          editorStore.setFileContent(file, newContent);
        }
        // Write to disk
        await writeFile(file, newContent);
      }
    } catch (err) {
      console.error(`Failed to update links in ${file}`, err);
    }
  }
}
