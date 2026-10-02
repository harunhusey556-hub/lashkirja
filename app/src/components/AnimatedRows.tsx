"use client";

import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type AnimatedRow = { key: string; node: ReactNode };

const EXIT_MS = 260;
const ENTER_MS = 280;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/**
 * More rows changing at once than this is a new list (a filter, a search, a
 * reload), not an edit: it swaps without motion, as a UITableView reloadData
 * does, instead of animating dozens of heights in one frame.
 */
const MAX_ANIMATED_CHANGES = 6;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * A list whose rows never pop. A row that leaves (done by the owner, or gone
 * from the server's next answer) stays where it was and folds to nothing; a
 * row that arrives unfolds from nothing. The rows around it slide instead of
 * jumping. Heights are animated in pixels with WAAPI, because WebKit steps a
 * grid-template-rows animation instead of interpolating it.
 */
export function AnimatedRows({ rows }: { rows: AnimatedRow[] }) {
  const [ghosts, setGhosts] = useState<ReadonlyMap<string, { node: ReactNode; index: number }>>(() => new Map());
  const previous = useRef<AnimatedRow[]>(rows);
  const seen = useRef<Set<string> | null>(null);
  const animating = useRef(new Set<string>());
  const nodes = useRef(new Map<string, HTMLDivElement>());

  // Rows gone since the last commit come back once as ghosts, before paint.
  useLayoutEffect(() => {
    const current = new Set(rows.map((row) => row.key));
    const gone = previous.current
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !current.has(row.key) && !ghosts.has(row.key));
    const arriving = rows.filter((row) => !previous.current.some((old) => old.key === row.key)).length;
    previous.current = rows;
    if (gone.length === 0 || reducedMotion() || gone.length + arriving > MAX_ANIMATED_CHANGES) return;
    setGhosts((map) => {
      const next = new Map(map);
      for (const { row, index } of gone) next.set(row.key, { node: row.node, index });
      return next;
    });
  }, [rows, ghosts]);

  // Animate what changed in this commit.
  useLayoutEffect(() => {
    const first = seen.current === null;
    const keys = new Set(rows.map((row) => row.key));

    const fold = (key: string, el: HTMLDivElement) => {
      animating.current.add(key);
      const height = el.offsetHeight;
      el.style.overflow = "hidden";
      const animation = el.animate(
        [
          { height: `${height}px`, opacity: 1 },
          { height: "0px", opacity: 0 },
        ],
        { duration: EXIT_MS, easing: EASE, fill: "forwards" }
      );
      animation.onfinish = () => {
        animating.current.delete(key);
        setGhosts((map) => {
          const next = new Map(map);
          next.delete(key);
          return next;
        });
      };
    };

    const unfold = (key: string, el: HTMLDivElement) => {
      animating.current.add(key);
      const height = el.offsetHeight;
      el.style.overflow = "hidden";
      const animation = el.animate(
        [
          { height: "0px", opacity: 0 },
          { height: `${height}px`, opacity: 1 },
        ],
        { duration: ENTER_MS, easing: EASE }
      );
      const done = () => {
        animating.current.delete(key);
        el.style.overflow = "";
      };
      animation.onfinish = done;
      animation.oncancel = done;
    };

    const arriving = first ? 0 : rows.filter((row) => !seen.current!.has(row.key)).length;
    const calm = arriving + ghosts.size <= MAX_ANIMATED_CHANGES;
    for (const [key, el] of nodes.current) {
      if (keys.has(key) && ghosts.has(key)) {
        // Undone mid-exit (Kumoa): React kept the same element. Stop the fold,
        // drop the ghost, and unfold the row again.
        el.getAnimations().forEach((animation) => {
          animation.onfinish = null;
          animation.cancel();
        });
        el.style.overflow = "";
        animating.current.delete(key);
        setGhosts((map) => {
          const next = new Map(map);
          next.delete(key);
          return next;
        });
        if (!reducedMotion()) unfold(key, el);
        continue;
      }
      if (animating.current.has(key)) continue;
      if (ghosts.has(key)) fold(key, el);
      else if (!first && calm && !seen.current!.has(key) && !reducedMotion()) unfold(key, el);
    }
    seen.current = keys;
  }, [rows, ghosts]);

  // Live rows in order, each ghost back at the place it left.
  const merged: Array<AnimatedRow & { ghost?: true }> = [...rows];
  for (const [key, ghost] of [...ghosts].sort((a, b) => a[1].index - b[1].index)) {
    if (merged.some((row) => row.key === key)) continue;
    merged.splice(Math.min(ghost.index, merged.length), 0, { key, node: ghost.node, ghost: true });
  }

  return (
    <>
      {merged.map((row) => (
        <Fragment key={row.key}>
          <div
            ref={(el) => {
              if (el) nodes.current.set(row.key, el);
              else nodes.current.delete(row.key);
            }}
            inert={row.ghost || undefined}
            aria-hidden={row.ghost || undefined}
            className={row.ghost ? "pointer-events-none" : undefined}
          >
            {row.node}
          </div>
        </Fragment>
      ))}
    </>
  );
}
