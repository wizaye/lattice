import React from "react";

/**
 * Icon set backed by @vscode/codicons. Each export is a tiny React
 * component that renders an `<i class="codicon codicon-X lattice-icon">`
 * span. The wrapper element preserves the same component API the rest of
 * the app already uses (`<IcSearch />`, etc.), so call sites don't need
 * to change. Color inherits from `currentColor` because @vscode/codicons
 * ship as an icon font.
 */
type IProps = React.HTMLAttributes<HTMLSpanElement>;

const cx = (...parts: Array<string | undefined | false>) =>
  parts.filter(Boolean).join(" ");

const codicon =
  (name: string): React.FC<IProps> =>
  ({ className, ...rest }) => (
    <i
      aria-hidden="true"
      {...rest}
      className={cx("codicon", `codicon-${name}`, "lattice-icon", className)}
    />
  );

/* ------------------------------------------------------------------
 * Mapping — each Ic* maps to the codicon glyph that best matches the
 * Obsidian-style screenshot. Names are intentionally close to Obsidian's
 * own iconography (folder/search/bookmark on the left rail, link/tag/
 * archive on the right rail, layout-sidebar-* for the panel toggles).
 * ------------------------------------------------------------------ */

// Panel + window chrome
//
// IcPanelLeft / IcPanelRight are state-aware: pass `open={false}` and
// they swap to the codicon `*-off` variant. Default `open={true}` keeps
// them back-compatible with callers that don't care about state.
type ToggleProps = IProps & { open?: boolean };

export const IcPanelLeft: React.FC<ToggleProps> = ({
  open = true,
  className,
  ...rest
}) => (
  <i
    aria-hidden="true"
    {...rest}
    className={cx(
      "codicon",
      open ? "codicon-layout-sidebar-left" : "codicon-layout-sidebar-left-off",
      "lattice-icon",
      className,
    )}
  />
);

export const IcPanelRight: React.FC<ToggleProps> = ({
  open = true,
  className,
  ...rest
}) => (
  <i
    aria-hidden="true"
    {...rest}
    className={cx(
      "codicon",
      open ? "codicon-layout-sidebar-right" : "codicon-layout-sidebar-right-off",
      "lattice-icon",
      className,
    )}
  />
);

export const IcMinimize = codicon("chrome-minimize");
export const IcMaximize = codicon("chrome-maximize");
export const IcClose = codicon("close");

// Left rail / view switchers
export const IcFolder = codicon("folder");
export const IcSearch = codicon("search");
export const IcBookmark = codicon("bookmark");

// Left activity strip (Obsidian core plugins)
export const IcGraph = codicon("type-hierarchy");
export const IcGrid = codicon("table");
export const IcCalendar = codicon("calendar");
export const IcFiles = codicon("files");
export const IcTerminal = codicon("terminal");
export const IcKanban = codicon("project");

// File-tree toolbar
export const IcEdit = codicon("edit");
export const IcNewFolder = codicon("new-folder");
export const IcSortAZ = codicon("arrow-swap");
export const IcCollapseAll = codicon("chrome-close");
export const IcMore = codicon("ellipsis");

// Chevrons + plus
export const IcChevronDown = codicon("chevron-down");
export const IcChevronLeft = codicon("chevron-left");
export const IcChevronRight = codicon("chevron-right");
export const IcChevronUp = codicon("chevron-up");
export const IcPlus = codicon("add");
export const IcMinus = codicon("dash");

// Canvas
export const IcStickyNote = codicon("note");
export const IcLayout = codicon("layout");

// Canvas toolbar — drawing + shape tools
export const IcCursor = codicon("inspect"); // select / move tool
export const IcHand = codicon("move"); // pan / hand tool
export const IcPencil = codicon("pencil"); // freehand pen
// Eraser — codicons doesn't ship a real eraser glyph (`discard` is a
// revert-arrow), so we inline a Lucide-style eraser path. Color
// inherits from currentColor so it matches the toolbar theme.
export const IcEraser: React.FC<IProps> = ({ className, ...rest }) => (
  <span
    aria-hidden="true"
    {...rest}
    className={cx("lattice-icon", "lattice-icon-svg", className)}
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      ...(rest.style ?? {}),
    }}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  </span>
);
export const IcSquare = codicon("primitive-square"); // rectangle shape
export const IcCircle = codicon("circle-outline"); // ellipse shape
export const IcDiamond = codicon("symbol-misc"); // diamond shape (closest glyph)
export const IcArrowTool = codicon("arrow-right"); // arrow / connector
export const IcTextTool = codicon("text-size"); // text tool
export const IcGroup = codicon("group-by-ref-type"); // group selection
export const IcExport = codicon("export"); // export menu trigger
export const IcKebab = codicon("kebab-vertical"); // generic more
// Drag-grip handle (two vertical columns of dots). Used by the
// movable canvas toolbar.
export const IcGrip: React.FC<IProps> = ({ className, ...rest }) => (
  <span
    aria-hidden="true"
    {...rest}
    className={cx("lattice-icon", "lattice-icon-svg", className)}
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      ...(rest.style ?? {}),
    }}
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="5" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="9" cy="19" r="1.4" />
      <circle cx="15" cy="5" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="15" cy="19" r="1.4" />
    </svg>
  </span>
);

// Right rail (links / outgoing / tags / archive / outline)
export const IcLink = codicon("link");
export const IcLinkOff = codicon("references");
export const IcTag = codicon("tag");
export const IcArchive = codicon("archive");
export const IcList = codicon("list-unordered");

// Editor doc header
export const IcArrowLeft = codicon("arrow-left");
export const IcArrowRight = codicon("arrow-right");
export const IcArrowUp = codicon("arrow-up");
export const IcArrowDown = codicon("arrow-down");
export const IcBook = codicon("book");

// Misc / footer
export const IcSwap = codicon("arrow-swap");
export const IcSplit = codicon("split-horizontal");
export const IcHelp = codicon("question");
export const IcGear = codicon("settings-gear");
export const IcLock = codicon("lock");
export const IcExpand = codicon("screen-full");

// Theme toggle — codicons does not ship a moon glyph, so both states
// reuse `color-mode`; the surrounding button title flips between
// “Switch to light theme” and “Switch to dark theme”.
export const IcSun = codicon("color-mode");
export const IcMoon = codicon("color-mode");

// Settings modal — section icons
export const IcFileLink = codicon("file-symlink-file");
export const IcPaint = codicon("symbol-color");
export const IcKeyboard = codicon("keyboard");
export const IcKey = codicon("key");
export const IcExtensions = codicon("extensions");
export const IcHistory = codicon("history");
export const IcPreview = codicon("preview");
export const IcSync = codicon("sync");
export const IcSyncIgnored = codicon("sync-ignored");
export const IcMerge = codicon("git-merge");
export const IcCheck = codicon("check");
export const IcFileSubmodule = codicon("file-submodule");

// Tabbar "View options" + markdown "More options" menus
export const IcStack = codicon("layers");
export const IcCloseAll = codicon("close-all");
export const IcNewFile = codicon("new-file");
export const IcEye = codicon("eye");
export const IcCode = codicon("code");
export const IcLinkExternal = codicon("link-external");
export const IcFileAdd = codicon("file-add");
export const IcFilePdf = codicon("file-pdf");
export const IcReplace = codicon("replace");
export const IcCopy = codicon("copy");
export const IcFolderOpened = codicon("folder-opened");
export const IcLocation = codicon("location");
export const IcTrash = codicon("trash");
