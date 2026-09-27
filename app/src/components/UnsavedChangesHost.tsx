"use client";

import { useEffect, useRef, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { DISCARD_DESCRIPTION, DISCARD_TITLE, setLeaveHandler } from "@/lib/form-guard";

/** One confirm dialog for back, tabs, and an editor's own cancel. */
export function UnsavedChangesHost() {
  const [open, setOpen] = useState(false);
  const proceedRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setLeaveHandler((proceed) => {
      proceedRef.current = proceed;
      setOpen(true);
    });
    return () => setLeaveHandler(null);
  }, []);

  return (
    <ConfirmModal
      isOpen={open}
      title={DISCARD_TITLE}
      description={DISCARD_DESCRIPTION}
      confirmLabel="Hylkää"
      cancelLabel="Jatka muokkausta"
      onConfirm={() => {
        const proceed = proceedRef.current;
        proceedRef.current = null;
        setOpen(false);
        proceed?.();
      }}
      onCancel={() => {
        proceedRef.current = null;
        setOpen(false);
      }}
    />
  );
}
