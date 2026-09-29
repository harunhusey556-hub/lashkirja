/**
 * A synchronous "there is a stored session" hint (SHELL-25).
 *
 * The real token lives in the Keychain, which can only be read
 * asynchronously. That made the first screen wait for `bootMobile()` before
 * `/` could decide between the shell and the login page. This flag is
 * written by auth-client whenever the stored session changes (sign-in,
 * sign-out, expiry, and every boot read) so the boot page can decide in its
 * first effect and then let the real boot run underneath.
 *
 * It is only a hint. A flag that is set while the token is gone is corrected
 * by the boot read, and the shell revalidates the session against the API.
 * It holds no secret: the value is the literal "1".
 */
export const SIGNED_IN_FLAG_KEY = "lashkirja.signedin.v1";

export function setSignedInFlag(signedIn: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (signedIn) localStorage.setItem(SIGNED_IN_FLAG_KEY, "1");
    else localStorage.removeItem(SIGNED_IN_FLAG_KEY);
  } catch {
    // Private mode or blocked storage: the boot page falls back to bootMobile().
  }
}

export function readSignedInFlag(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SIGNED_IN_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
