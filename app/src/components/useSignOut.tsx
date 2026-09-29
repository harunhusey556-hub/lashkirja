"use client";

import { useCallback, useState, type ReactNode } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { leaveAfterSignOut } from "@/components/clientFetch";
import { useOfflineReceiptQueue } from "@/components/useOfflineReceiptQueue";

const SIGN_OUT_FAILED = "Uloskirjautuminen epäonnistui. Istunto voi olla yhä voimassa.";

/** "1 kuitti odottaa lähetystä." / "3 kuittia odottaa lähetystä." */
export function queuedReceiptsCountLabel(count: number): string {
  return count === 1 ? "1 kuitti odottaa lähetystä." : `${count} kuittia odottaa lähetystä.`;
}

/**
 * The one sign-out flow (AUTH-03), shared by the avatar sheet and the
 * Asetukset page. Logout wipes the offline photo queue together with the
 * persistent cache (auth-client's clearClientAuthState), so anything still
 * waiting to send would be lost: with queued photos the flow asks first, and
 * otherwise signs out at once.
 *
 *   const { requestSignOut, signingOut, signOutError, confirmDialog } = useSignOut();
 *   ...
 *   <button onClick={requestSignOut} disabled={signingOut}>Kirjaudu ulos</button>
 *   {confirmDialog}
 *
 * Render `confirmDialog` once, anywhere in the tree of the caller. This hook
 * also mounts the queue's drain driver (useOfflineReceiptQueue), so the
 * shell keeps calling it for that side effect.
 */
export function useSignOut(options: { onBeforeSignOut?: () => void } = {}): {
  requestSignOut: () => void;
  signingOut: boolean;
  signOutError: string;
  confirmDialog: ReactNode;
} {
  const { onBeforeSignOut } = options;
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { rows } = useOfflineReceiptQueue();
  // "done" rows are kept for 24 h purely for the queue card's own "Lähetetty"
  // note: they are delivered, so they never count as "lost on logout".
  const queuedCount = rows.filter((row) => row.status !== "done").length;

  const signOutNow = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    setConfirmOpen(false);
    onBeforeSignOut?.();
    const left = await leaveAfterSignOut();
    if (!left) {
      setSigningOut(false);
      setSignOutError(SIGN_OUT_FAILED);
    }
  }, [signingOut, onBeforeSignOut]);

  const requestSignOut = useCallback(() => {
    if (signingOut) return;
    if (queuedCount > 0) {
      setConfirmOpen(true);
      return;
    }
    void signOutNow();
  }, [queuedCount, signingOut, signOutNow]);

  const confirmDialog = (
    <ConfirmModal
      isOpen={confirmOpen}
      title="Kirjaudutaanko ulos?"
      description={`${queuedReceiptsCountLabel(queuedCount)} Jos kirjaudut ulos, ne poistetaan tästä laitteesta.`}
      confirmLabel="Kirjaudu ulos"
      cancelLabel="Peruuta"
      onConfirm={signOutNow}
      onCancel={() => setConfirmOpen(false)}
    />
  );

  return { requestSignOut, signingOut, signOutError, confirmDialog };
}
