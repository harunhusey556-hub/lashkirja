/**
 * The mobile boot sequence: is there a stored session, and whose is it.
 * Replaces BootRedirect's placeholder uncredentialed fetch (Task 4) with a
 * real Keychain read.
 */
import { loadStoredAuth, refreshTokenIfDue, retryPendingRevoke } from "@/lib/auth-client";

export interface BootResult {
  signedIn: boolean;
  userId: string | null;
}

let bootPromise: Promise<BootResult> | null = null;

async function runBoot(): Promise<BootResult> {
  const stored = await loadStoredAuth();
  // "app launch" retry point for a logout whose server call failed earlier.
  void retryPendingRevoke();
  if (!stored) return { signedIn: false, userId: null };
  // Fire-and-forget: a slow or failed refresh must not block the boot
  // decision -- the stored token is still valid right up to its own expiry.
  void refreshTokenIfDue();
  return { signedIn: true, userId: stored.userId };
}

/** Memoized: resolves in one pass per app launch. */
export function bootMobile(): Promise<BootResult> {
  if (!bootPromise) bootPromise = runBoot();
  return bootPromise;
}
