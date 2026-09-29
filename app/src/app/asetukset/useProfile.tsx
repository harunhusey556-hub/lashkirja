"use client";

import { useCallback, useEffect, useState } from "react";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { FormError, SavedNote } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";

export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  pendingEmail?: string | null;
  entityType: string;
  vatRegistered: boolean;
  vatPeriod: string;
  /** Seller display name (also editable on /asetukset/laskutus); optional since not every account has set it. */
  businessName?: string | null;
  imapAccounts: { id: string; email: string }[];
}

/**
 * The one profile load/save used by every settings page. Saves are
 * optimistic: the UI flips immediately and rolls back on failure.
 *
 * The first render already holds the last profile (SHELL-08): the initial
 * state reads the page cache synchronously, which the app boot has hydrated
 * from the encrypted store before any screen mounts, so Koti's subtitle and
 * the settings forms never pop in after the network round trip.
 */
export function useProfile() {
  const [fetchedProfile, setProfile] = useState<Profile | null>(
    () => readPageCache<Profile>("profile")
  );
  // Cold launch: the persistent cache is hydrated after this hook first ran,
  // so the copy from the last session paints once it is readable, not after
  // the network round trip (N3).
  const lateProfile = useCacheAfterBoot<Profile>("profile");
  const profile = fetchedProfile ?? lateProfile;
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/profile", { signal: controller.signal })
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

  /** Fetch the profile again now and swap it in (e.g. after a connect that changed ids). */
  const reload = useCallback(async (): Promise<boolean> => {
    try {
      const response = await apiFetch("/api/profile");
      const data = await readJson<{ profile: Profile }>(response, "Asetusten lataus epäonnistui");
      if (!data.profile) return false;
      writePageCache("profile", data.profile);
      setProfile(data.profile);
      setLoadError("");
      return true;
    } catch {
      return false;
    }
  }, []);

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
        const res = await apiFetch("/api/profile", {
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
        window.setTimeout(() => {
          setSavedMsg((current) => (current === "Tallennettu" ? "" : current));
        }, 8000);
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
      }
    },
    [profile, saving]
  );

  return { profile, setProfile, saving, savedMsg, loadError, retry, reload, save };
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
      <p className="text-caption text-success" role="status" aria-live="polite">
        Tallennetaan...
      </p>
    );
  }
  const isError = Boolean(savedMsg) && savedMsg !== "Tallennettu";
  if (isError) return <FormError message={savedMsg} className="text-caption" />;
  return <SavedNote message={savedMsg} className="text-caption" />;
}
