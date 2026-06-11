/**
 * CodeMirror extensions for Lattice
 * Obsidian-compatible features + Vim mode + Diagrams
 */

export { vimMode, getVimStatus } from './cm-vim';
export { embedsExtension } from './cm-embeds';
export { calloutsExtension } from './cm-callouts';
export { frontmatterExtension } from './cm-frontmatter';
export { headingFoldExtension } from './cm-heading-fold';
export { sectionLinksExtension } from './cm-section-links';
export { mermaidExtension, plantumlExtension, latexExtension } from './cm-diagrams';
