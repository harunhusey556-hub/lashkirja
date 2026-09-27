"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/components/clientFetch";
import { clearDraft, readDraft, saveDraft } from "@/lib/draft-store";
import { registerDirtySource, requestLeave } from "@/lib/form-guard";

export type SavePhase = "clean" | "dirty" | "saving" | "saved" | "failed";

export function isVersionConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.message.includes("Lataa tiedot uudelleen")
  );
}

/**
 * Dirty tracking, local draft, and leave confirmation for one editor.
 * A profile save does not register here, so it never raises the guard.
 */
export function useEditorSession<T>(options: {
  sourceId: string;
  draftKey: string | null;
  baseline: T;
  value: T;
  active?: boolean;
  onRestore: (value: T) => void;
}) {
  const active = options.active !== false;
  const baselineKey = JSON.stringify(options.baseline);
  const valueKey = JSON.stringify(options.value);
  const dirty = active && valueKey !== baselineKey;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const onRestore = useRef(options.onRestore);
  onRestore.current = options.onRestore;
  const restored = useRef<string | null>(null);
  const skipSave = useRef(false);
  const valueRef = useRef(options.value);
  valueRef.current = options.value;
  const draftKeyRef = useRef(options.draftKey);
  draftKeyRef.current = options.draftKey;
  const [notice, setNotice] = useState("");
  const [phase, setPhase] = useState<SavePhase>("clean");

  useEffect(() => {
    return registerDirtySource(options.sourceId, () => dirtyRef.current);
  }, [options.sourceId]);

  useEffect(() => {
    if (!active || !options.draftKey) return;
    if (restored.current === options.draftKey) return;
    restored.current = options.draftKey;
    const draft = readDraft<T>(options.draftKey);
    if (!draft || JSON.stringify(draft.value) === baselineKey) return;
    onRestore.current(draft.value);
    setNotice("Luonnos palautettiin.");
  }, [active, options.draftKey, baselineKey]);

  useEffect(() => {
    if (!options.draftKey || !dirty) return;
    skipSave.current = false;
    const key = options.draftKey;
    const handle = window.setTimeout(() => {
      if (!skipSave.current) saveDraft(key, valueRef.current);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [options.draftKey, options.value, dirty]);

  useEffect(() => {
    const key = options.draftKey;
    return () => {
      if (!key || !dirtyRef.current || skipSave.current) return;
      saveDraft(key, valueRef.current);
    };
  }, [options.draftKey]);

  useEffect(() => {
    const persist = () => {
      const key = draftKeyRef.current;
      if (!key || !dirtyRef.current || skipSave.current) return;
      saveDraft(key, valueRef.current);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      persist();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", persist);
    };
  }, []);

  useEffect(() => {
    setPhase((current) => {
      if (current === "saving" || current === "failed") return current;
      if (dirty) return "dirty";
      if (current === "saved") return "saved";
      return "clean";
    });
  }, [dirty]);

  function clearSavedDraft() {
    skipSave.current = true;
    if (options.draftKey) clearDraft(options.draftKey);
    setNotice("");
  }

  function requestCancel(proceed: () => void) {
    requestLeave(() => {
      clearSavedDraft();
      proceed();
    });
  }

  return { dirty, notice, setNotice, phase, setPhase, clearSavedDraft, requestCancel };
}
