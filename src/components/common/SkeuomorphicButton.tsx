/**
 * SkeuomorphicButton — dark skeuomorphic raised button.
 *
 * Follows the project skeuomorphic-ui skill:
 *   • Raised shell material:  linear-gradient(#202020 -> #191919)
 *   • Top-lit highlights + black depth lift shadow stack
 *   • Subtle active scale (0.97) for tactile press feedback
 *
 * Usage:
 *
 *   import { SkeuomorphicButton } from "@/components/common/SkeuomorphicButton";
 *
 *   <SkeuomorphicButton onClick={...}>Save</SkeuomorphicButton>
 *
 *   // Circular icon button inside an inset well:
 *   <div className="skeuo-inset-well" style={{ width: 44, height: 44 }}>
 *     <SkeuomorphicButton variant="circle" aria-label="Play">
 *       <PlayIcon />
 *     </SkeuomorphicButton>
 *   </div>
 *
 * Place inside a container with a background between #080808 and #1a1a1a
 * so the lift shadows read correctly. The included `.skeuo-scene` helper
 * class provides a compliant scene background.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./SkeuomorphicButton.css";

type Variant = "raised" | "circle";

interface SkeuomorphicButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant. `"raised"` (default) for standard buttons,
   *  `"circle"` for circular icon buttons (wrap in `.skeuo-inset-well`). */
  variant?: Variant;
  /** Optional leading icon node, rendered before children. */
  icon?: ReactNode;
}

export function SkeuomorphicButton({
  variant = "raised",
  icon,
  children,
  className,
  type = "button",
  ...rest
}: SkeuomorphicButtonProps) {
  const classes = [
    "skeuo-btn",
    variant === "circle" ? "skeuo-btn--circle" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button {...rest} type={type} className={classes}>
      {icon && <span className="skeuo-btn__icon">{icon}</span>}
      {children}
    </button>
  );
}
