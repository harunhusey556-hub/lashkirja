"use client";

import { useCallback, useEffect, useState } from "react";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { FormError, SavedNote } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";

export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  entityType: string;
  vatRegistered: boolean;
  vatPeriod: string;
  imapAccounts: { id: string; email: string }[];
}

/**
 * The one profile load/save used by every settings page. Saves are
 * optimistic: the UI flips immediately and rolls back on failure.
 */
export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(
    () => readPageCache<Profile>("profile")
  );
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/profile", { signal: controller.signal })
      .then((response) =>
        readJson<{ profile: Profile }>(response, "Asetusten lataus epäonnistui")
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data.profile) {
          throw new Error("Palvelin palautti virheelliset asetukset");
        }
        setLoadError("");
        writePageCache("profile", data.profile);
        setProfile(data.profile);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(errorMessage(error, "Asetusten lataus epäonnistui"));
      });
    return () => controller.abort();
  }, [loadAttempt]);

  const retry = useCallback(() => {
    setLoadError("");
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const save = useCallback(
    async (update: Partial<Profile>): Promise<boolean> => {
      if (!profile || saving) return false;
      const previous = profile;
      setProfile({ ...profile, ...update });
      setSaving(true);
      setSavedMsg("");
      try {
        const res = await fetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });
        const data = await readJson<{ profile: Partial<Profile> }>(
          res,
          "Tallennus epäonnistui"
        );
        setProfile((current) => {
          const next = current ? { ...current, ...data.profile } : current;
          if (next) writePageCache("profile", next);
          return next;
        });
        setSavedMsg("Tallennettu");
        void hapticNotify("success");
        return true;
      } catch (error: unknown) {
        if (isUnauthorized(error)) {
          redirectToLogin();
          return false;
        }
        setProfile(previous);
        setSavedMsg(errorMessage(error, "Tallennus epäonnistui"));
        void hapticNotify("error");
        return false;
      } finally {
        setSaving(false);
        setTimeout(() => setSavedMsg(""), 3000);
      }
    },
    [profile, saving]
  );

  return { profile, setProfile, saving, savedMsg, loadError, retry, save };
}

/** Shared save/error status line under settings forms. */
export function SaveStatus({
  saving,
  savedMsg,
}: {
  saving: boolean;
  savedMsg: string;
}) {
  if (saving) {
    return (
      <p className="text-xs text-success" role="status" aria-live="polite">
        Tallennetaan...
      </p>
    );
  }
  const isError = Boolean(savedMsg) && savedMsg !== "Tallennettu";
  if (isError) return <FormError message={savedMsg} className="text-xs" />;
  return <SavedNote message={savedMsg} className="text-xs" />;
}
