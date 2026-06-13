/**
 * Git-graph lane assignment — pure function.
 *
 * Takes a list of commits in newest-first order (the natural output
 * of `git log --all --date-order`) and produces one `LaneRow` per
 * commit describing where it lives on the SVG canvas:
 *
 *   - which lane (vertical column) the commit's dot sits in
 *   - which lanes are "passing through" this row (vertical lines that
 *     belong to other branches but happen to be active here)
 *   - which lanes the commit's parents will occupy in the NEXT row
 *     (so the renderer knows where to draw the connector curves)
 *
 * # Algorithm (gitk-style, simplified)
 *
 * We maintain an `activeLanes: (string | null)[]` array — one slot per
 * vertical column.  Each slot stores the sha of the commit that
 * "owns" that lane, or `null` for an empty lane.
 *
 * Walking commits newest-first:
 *
 *   1. **Find my lane.**  If a previous (child) commit already
 *      reserved a lane for us, use it.  If multiple children reserved
 *      lanes for us (we're a merge target seen from above), keep the
 *      leftmost and free the others — those branches are merging into
 *      our lane right now.
 *
 *      If no lane is reserved (we're a new branch tip), allocate the
 *      first empty slot or extend the array.
 *
 *   2. **Snapshot lanes before this row.**  This is what the renderer
 *      uses to draw vertical lines for OTHER branches passing through
 *      this row alongside our dot.
 *
 *   3. **Free our lane and reserve parents.**  Our slot is now empty.
 *      For each parent:
 *
 *      - If some other slot already owns the parent (a parent reached
 *        by multiple children), reuse it — no new lane needed.
 *      - Otherwise, the FIRST parent prefers our lane (continues the
 *        column).  Subsequent parents (merge ancestors) take the first
 *        empty slot.
 *
 * # Why we don't ship server-side rendering
 *
 * Git itself doesn't give you lanes — `git log --graph` is ASCII art
 * built by the porcelain.  Pre-computing on the server would mean
 * shipping the same algorithm in Rust; doing it in TS keeps the IPC
 * surface tiny (`vcs_log_graph` returns the raw DAG only) and lets
 * us tweak the layout without rebuilding Rust.
 *
 * Performance: O(N · L) where L is the average active-lane count.
 * For 500 commits with ~5 lanes that's ~2500 operations — well under
 * a millisecond in V8.  We don't memoise.
 */

/** Minimum shape we need — `vcsLogGraph()` returns a superset. */
export interface GraphInputCommit {
  id: string;
  /** Parent shas. 0 = root, 1 = normal, 2+ = merge. */
  parents: string[];
}

/**
 * One row of the rendered graph.  The renderer treats each row as a
 * fixed-height strip with `lanesBefore` lanes (drawn as vertical
 * lines), a dot at `lane`, and `connectors` to the parent lanes in
 * the row below.
 */
export interface LaneRow<C extends GraphInputCommit = GraphInputCommit> {
  /** The commit this row represents. */
  commit: C;
  /** Column index of this commit's dot (0 = leftmost). */
  lane: number;
  /**
   * Which sha is in each lane DURING this row (before we free our own
   * slot for the next row).  Used by the renderer to draw the vertical
   * passing-through lines.  Length = the high-water mark of active
   * lanes for any row processed so far.
   */
  lanesBefore: (string | null)[];
  /**
   * Which sha is in each lane AFTER our parents have been reserved —
   * this is what the NEXT row will see as its `lanesBefore`.  The
   * renderer doesn't usually need this directly (it's consumed by the
   * next iteration), but exposed for tests + future renderer tweaks.
   */
  lanesAfter: (string | null)[];
  /**
   * Lane indices our parents will sit in (in the NEXT row).  Same
   * order as `commit.parents`.  Empty when this is a root commit.
   *
   * The renderer draws one connector per entry:
   *   - if `parentLanes[i] === lane`            → straight vertical
   *   - if `parentLanes[i] !== lane`            → curved bezier
   *
   * For merges (parents.length > 1), the second+ connectors usually
   * fan out to the right; the first parent typically stays in our
   * column (continuation of the branch).
   */
  parentLanes: number[];
}

/**
 * Walk commits in newest-first order and assign each to a lane.
 *
 * `commits` is consumed as-is (no reorder); the input MUST already
 * be in a sensible order (date-order or topo-order — `git log
 * --date-order` is what `vcs_log_graph` uses).
 *
 * Returns one row per input commit, in the same order.
 */
export function assignLanes<C extends GraphInputCommit>(
  commits: C[],
): LaneRow<C>[] {
  // Mutable view of which sha owns each lane right now.  A `null`
  // means the lane is free (we can reuse it instead of widening the
  // array — keeps the graph narrow when branches merge back in).
  const lanes: (string | null)[] = [];

  /** Index of the leftmost empty (null) slot, extending if needed. */
  const allocLane = (): number => {
    const idx = lanes.indexOf(null);
    if (idx >= 0) return idx;
    lanes.push(null);
    return lanes.length - 1;
  };

  const rows: LaneRow<C>[] = [];

  for (const c of commits) {
    // 1. Find lanes already reserved for this commit by some child.
    //    Collect ALL of them — a commit can be the target of multiple
    //    branches merging in (i.e. multiple children with this commit
    //    as a parent).  Earliest (leftmost) lane wins; the rest are
    //    freed because those branches are converging into our lane.
    const reserved: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === c.id) reserved.push(i);
    }

    let lane: number;
    if (reserved.length > 0) {
      lane = reserved[0];
      // Free the extra reserved slots — they're collapsing into ours.
      for (let i = 1; i < reserved.length; i++) {
        lanes[reserved[i]] = null;
      }
    } else {
      // No child claimed this commit (branch tip / orphan root).
      // Allocate a fresh leftmost lane.
      lane = allocLane();
    }

    // 2. Snapshot what the renderer sees DURING this row.  Our slot
    //    still shows our sha at this point — that's correct: the dot
    //    sits on top of the existing column.
    lanes[lane] = c.id;
    const lanesBefore = lanes.slice();

    // 3. Free our slot and reserve lanes for each parent.
    lanes[lane] = null;
    const parentLanes: number[] = new Array(c.parents.length);

    for (let i = 0; i < c.parents.length; i++) {
      const p = c.parents[i];

      // If some other lane already reserves this parent (because a
      // different branch already declared the parent as ITS next
      // target), reuse it — saves a lane and creates the visual
      // "merge" effect when both branches connect to the same parent.
      let existing = -1;
      for (let j = 0; j < lanes.length; j++) {
        if (lanes[j] === p) {
          existing = j;
          break;
        }
      }
      if (existing >= 0) {
        parentLanes[i] = existing;
        continue;
      }

      if (i === 0 && lanes[lane] === null) {
        // First parent prefers to stay in our column — visually this
        // is "the branch continues straight down".
        lanes[lane] = p;
        parentLanes[i] = lane;
      } else {
        // Second+ parent (merge ancestors) or our column already
        // taken — grab the first empty slot.
        const slot = allocLane();
        lanes[slot] = p;
        parentLanes[i] = slot;
      }
    }

    rows.push({
      commit: c,
      lane,
      lanesBefore,
      lanesAfter: lanes.slice(),
      parentLanes,
    });

    // 4. Trim trailing nulls so the lane array doesn't grow
    //    unboundedly when branches end (root commits).  Keeps the
    //    `lanesBefore.length` reasonable for downstream layout math.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
  }

  return rows;
}

/**
 * Stable colour for a lane index — cycles through 6 distinguishable
 * hues that read in both light + dark themes.  Renderers use these
 * as inline `stroke=` / `fill=` on SVG paths.  Indices wrap, so a
 * graph with 20+ lanes will repeat colours; that's OK because
 * adjacent lanes rarely share an index after wrapping.
 *
 * Palette tuned against the `.cp-subsection-staged` / `.cp-subsection-
 * untracked` accent strip colours so the graph feels native to the
 * Changes panel.
 */
const LANE_PALETTE = [
  "#4a9eff", // blue   — matches --accent
  "#5fb37b", // green  — matches the "added" glyph
  "#ffb74d", // amber  — matches the "modified" glyph
  "#e57373", // red    — matches the "deleted" glyph
  "#ba68c8", // purple
  "#4dd0e1", // cyan
];

export function laneColor(lane: number): string {
  return LANE_PALETTE[((lane % LANE_PALETTE.length) + LANE_PALETTE.length) %
    LANE_PALETTE.length];
}

/** Tag a ref string ("HEAD -> main", "tag: v1.0", "origin/main"). */
export type RefKind = "head" | "branch" | "remote" | "tag";

/** Parse one decoration ref into kind + cleaned name. */
export function classifyRef(raw: string): { kind: RefKind; name: string } {
  // %D format already strips parens; entries look like:
  //   "HEAD -> main"   "main"   "origin/main"   "tag: v0.1.0"   "HEAD"
  if (raw === "HEAD") return { kind: "head", name: "HEAD" };
  if (raw.startsWith("HEAD -> ")) {
    return { kind: "head", name: raw.slice("HEAD -> ".length) };
  }
  if (raw.startsWith("tag: ")) {
    return { kind: "tag", name: raw.slice("tag: ".length) };
  }
  // Remote branches look like "<remote>/<branch>" — git won't show
  // a slash in a local branch name unless the user manually used one
  // (e.g. `feature/x`).  We can't disambiguate purely from %D, so we
  // treat any name containing `/` whose first segment matches a
  // known remote pattern as remote.  For now: if it starts with
  // "origin/" / "upstream/" / "fork/" treat as remote; else branch.
  if (
    raw.startsWith("origin/") ||
    raw.startsWith("upstream/") ||
    raw.startsWith("fork/")
  ) {
    return { kind: "remote", name: raw };
  }
  return { kind: "branch", name: raw };
}
