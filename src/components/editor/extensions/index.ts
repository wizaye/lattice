/**
 * CodeMirror extensions for Lattice
 * Obsidian-compatible features + Vim mode + Diagrams + Live Preview + Slash Commands
 */

export { vimMode, getVimStatus } from './cm-vim';
export { embedsExtension } from './cm-embeds';
export { calloutsExtension } from './cm-callouts';
export { headingFoldExtension } from './cm-heading-fold';
export { sectionLinksExtension } from './cm-section-links';
export { mermaidExtension, plantumlExtension, latexExtension } from './cm-diagrams';
export { slashCompletionSource, slashThemeExtension } from './cm-slash-commands';
export { livePreviewExtension } from './cm-live-preview';
export { expandTemplateVariables, applyTemplateVariables } from './cm-template-variables';
export type { TemplateContext } from './cm-template-variables';
