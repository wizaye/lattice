import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IcCheck, IcFileSubmodule } from "../common/Icons";
import "./VaultPickerMenu.css";

type Props = {
  /** The trigger button — used to compute the menu's anchor rect. */
  anchor: HTMLElement | null;
  vaults: string[];
  active: string;
  onSelect: (vault: string) => void;
  onManage: () => void;
  onClose: () => void;
};

/**
 * Small popover that appears ABOVE the vault button in the left-sidebar
 * footer. Lists known vaults with a check on the active one and a
 * "Manage vaults…" entry separated by a divider.
 *
 * Rendered via a portal to `document.body` with `position: fixed` so
 * it escapes the left sidebar's `overflow: hidden` clipping — when the
 * sidebar is narrowed the menu still appears at full width on top of
 * everything else, instead of being cropped behind the splitter.
 *
 * Close behavior:
 *  - Esc.
 *  - Pointerdown outside the menu (and outside the trigger, so a second
 *    click on the trigger toggles cleanly).
 *  - Selecting a vault or clicking "Manage vaults…".
 *  - Window resize / scroll (the anchor rect would go stale).
 */
export function VaultPickerMenu({
  anchor,
  vaults,
  active,
  onSelect,
  onManage,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Anchor rect drives `position: fixed` top/left. Recomputed on mount,
  // window resize, and scroll so the menu tracks the trigger button.
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () => setRect(anchor.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const target = e.target instanceof Node ? e.target : null;
      if (target && el.contains(target)) return;
      // Clicks on the trigger itself bubble to the parent's toggle —
      // don't double-close there or the menu would re-open on the same
      // click.
      if (target && anchor && anchor.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose, anchor]);

  if (!rect) return null;

  // Anchor BOTTOM of the menu just above the trigger, LEFT-aligned to
  // the trigger so the menu opens upward-and-rightward. Using `bottom`
  // (not `top`) keeps the menu glued to the trigger even when its own
  // height grows/shrinks (e.g. as vaults are added).
  const style: React.CSSProperties = {
    position: "fixed",
    bottom: window.innerHeight - rect.top + 6,
    left: rect.left,
  };

  return createPortal(
    <div className="vault-menu" role="menu" ref={ref} style={style}>
      <ul className="vault-menu-list">
        {vaults.map((v) => (
          <li key={v}>
            <button
              role="menuitem"
              className={`vault-menu-item${v === active ? " active" : ""}`}
              onClick={() => onSelect(v)}
            >
              <span className="vault-menu-label">{v}</span>
              {v === active && <IcCheck className="vault-menu-check" />}
            </button>
          </li>
        ))}
      </ul>

      <div className="vault-menu-divider" role="separator" />

      <ul className="vault-menu-list">
        <li>
          <button
            role="menuitem"
            className="vault-menu-item"
            onClick={onManage}
          >
            <IcFileSubmodule className="vault-menu-leading" />
            <span className="vault-menu-label">Manage vaults…</span>
          </button>
        </li>
      </ul>
    </div>,
    document.body,
  );
}
