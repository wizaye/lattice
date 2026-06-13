/**
 * HintOverlay — Vimium/easymotion-style hint mode.
 *
 * Press `f` in vim normal mode (or `Ctrl+F` globally) to activate.
 * Coloured letter badges appear ON every interactive element.
 * Type the letters to instantly click/focus that element.
 *
 * Algorithm mirrors ZenNotes' HintOverlay.tsx exactly:
 *  - Home-row keys first (asdfghjkl), then the rest of the alphabet
 *  - Single-char labels while ≤17 targets; two-char labels beyond that
 *  - Smart placement: tries 6 positions around the target rect, picks
 *    the first one that doesn't overlap an already-placed label
 *  - Typed prefix highlighted in label; non-matching labels dim
 *  - Escape or any non-alpha key cancels; Backspace pops last char
 */

import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import "./HintOverlay.css";

// ─── Label generation (ZenNotes algorithm) ───────────────────────────────────

const HOME_ROW = "asdfghjkl";
const ALL_KEYS = HOME_ROW + "qwertyuiopzxcvbnm";

function generateHintLabels(count: number): string[] {
  const labels: string[] = [];
  if (count <= ALL_KEYS.length) {
    for (let i = 0; i < count && i < ALL_KEYS.length; i++) {
      labels.push(ALL_KEYS[i]);
    }
  } else {
    for (let i = 0; i < ALL_KEYS.length && labels.length < count; i++) {
      for (let j = 0; j < ALL_KEYS.length && labels.length < count; j++) {
        labels.push(ALL_KEYS[i] + ALL_KEYS[j]);
      }
    }
  }
  return labels;
}

// ─── Visible interactive elements ────────────────────────────────────────────

function getVisibleInteractiveElements(): HTMLElement[] {
  const selectors = [
    "button:not([disabled])",
    "a[href]",
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(", ");

  const all = document.querySelectorAll<HTMLElement>(selectors);
  const visible: HTMLElement[] = [];

  for (const el of all) {
    if (el.closest(".hint-overlay")) continue;
    if (el.closest("[data-hint-ignore]")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) continue;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) continue;
    visible.push(el);
  }
  return visible;
}

// ─── Smart label placement (ZenNotes algorithm) ──────────────────────────────

interface PlacedBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function overlaps(a: PlacedBox, b: PlacedBox): boolean {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  );
}

function clamp(val: number, min: number, max: number) {
  return Math.min(Math.max(val, min), max);
}

function getHintPlacement(
  rect: DOMRect,
  label: string,
  placed: PlacedBox[],
): { left: number; top: number } {
  const width = Math.max(18, label.length * 9 + 8);
  const height = 20;
  const gutter = 3;
  const maxLeft = Math.max(gutter, window.innerWidth - width - gutter);
  const maxTop = Math.max(gutter, window.innerHeight - height - gutter);

  const candidates = [
    { left: rect.left + gutter,              top: rect.top + gutter },
    { left: rect.left + gutter,              top: rect.top - height - gutter },
    { left: rect.right - width - gutter,     top: rect.top + gutter },
    { left: rect.right - width - gutter,     top: rect.top - height - gutter },
    { left: rect.left + gutter,              top: rect.bottom - height - gutter },
    { left: rect.right - width - gutter,     top: rect.bottom - height - gutter },
  ].map((pos) => ({
    left: clamp(pos.left, gutter, maxLeft),
    top:  clamp(pos.top,  gutter, maxTop),
  }));

  for (const c of candidates) {
    const box: PlacedBox = { ...c, width, height };
    if (!placed.some((p) => overlaps(box, p))) return c;
  }

  // Fallback: stack vertically from first candidate
  const fallback = candidates[0];
  for (let offset = 0; offset < window.innerHeight; offset += height + gutter) {
    const c = { left: fallback.left, top: clamp(fallback.top + offset, gutter, maxTop) };
    const box: PlacedBox = { ...c, width, height };
    if (!placed.some((p) => overlaps(box, p))) return c;
  }

  return fallback;
}

// ─── Hint target ─────────────────────────────────────────────────────────────

interface HintTarget {
  element: HTMLElement;
  label: string;
  left: number;
  top: number;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  onActivate: () => void;
  onCancel: () => void;
}

export function HintOverlay({ onActivate, onCancel }: Props) {
  const [buffer, setBuffer] = useState("");

  // Compute targets once on mount
  const targets = useMemo<HintTarget[]>(() => {
    const elements = getVisibleInteractiveElements();
    const labels = generateHintLabels(elements.length);
    const placed: PlacedBox[] = [];

    return elements.map((element, i) => {
      const label = labels[i];
      const rect = element.getBoundingClientRect();
      const pos = getHintPlacement(rect, label, placed);
      placed.push({
        ...pos,
        width: Math.max(18, label.length * 9 + 8),
        height: 20,
      });
      return { element, label, ...pos };
    });
  }, []);

  // Filter targets by current buffer
  const matching = useMemo(
    () => targets.filter((t) => t.label.startsWith(buffer)),
    [targets, buffer],
  );

  // Auto-click when exactly one match
  useEffect(() => {
    if (buffer.length > 0 && matching.length === 1) {
      const target = matching[0];
      const id = setTimeout(() => {
        target.element.click();
        target.element.focus();
        onActivate();
      }, 60);
      return () => clearTimeout(id);
    }
    if (buffer.length > 0 && matching.length === 0) {
      onCancel();
    }
  }, [buffer, matching, onActivate, onCancel]);

  // Keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") { onCancel(); return; }
      if (e.key === "Backspace") { setBuffer((b) => b.slice(0, -1)); return; }
      if (e.key.length === 1 && /^[a-z]$/i.test(e.key)) {
        setBuffer((b) => b + e.key.toLowerCase());
        return;
      }
      onCancel();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  // No elements → exit immediately
  useEffect(() => {
    if (targets.length === 0) onCancel();
  }, [targets.length, onCancel]);

  if (targets.length === 0) return null;

  return createPortal(
    <div className="hint-overlay">
      {/* Dimmed backdrop so users know the mode is active */}
      <div className="hint-backdrop" />

      {/* Labels positioned over elements */}
      {targets.map((t) => {
        const isMatch = t.label.startsWith(buffer);
        const matched = buffer;
        const remaining = t.label.slice(buffer.length);
        return (
          <span
            key={t.label}
            className={`hint-label${isMatch ? "" : " hint-label--dim"}`}
            style={{ left: t.left, top: t.top }}
          >
            {matched && <span className="hint-label-matched">{matched}</span>}
            {remaining}
          </span>
        );
      })}
    </div>,
    document.body,
  );
}
