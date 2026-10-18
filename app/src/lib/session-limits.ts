/** DB-free on purpose: auth-credential.ts (used by proxy.ts) imports these. */

/** A session with no request for this long is dead, whatever its tokens say. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap from sign-in; after it the password (or a passkey) is asked again. */
export const SESSION_ABSOLUTE_MS = 180 * 24 * 60 * 60 * 1000;
/** lastSeenAt is written at most this often per session: it only has to resolve the idle limit. */
export const SESSION_TOUCH_MS = 10 * 60 * 1000;
/** After a refresh commits, the previous token still works this long (requests already in flight). */
export const ROTATION_GRACE_MS = 2 * 60 * 1000;
/** Allowed clock difference between the device's X-LK-Device-Time and the server. */
export const DEVICE_SIGNATURE_SKEW_S = 300;
