"use client";

import { useState } from "react";

let next = 0;
const newKey = () => `line-${++next}`;

/**
 * Stable keys for invoice rows, which have no id of their own. Keyed by
 * position, removing row 2 of 3 animated row 3 out and left row 2's fields
 * under row 3's key. Add and remove keep the keys in step with the rows; a
 * row count changed from outside (a loaded draft) starts a fresh set.
 */
export function useLineKeys(count: number) {
  const [keys, setKeys] = useState<string[]>(() => Array.from({ length: count }, newKey));
  if (keys.length !== count) setKeys(Array.from({ length: count }, newKey));
  return {
    keys,
    add: () => setKeys((current) => [...current, newKey()]),
    remove: (index: number) => setKeys((current) => current.filter((_, i) => i !== index)),
  };
}
