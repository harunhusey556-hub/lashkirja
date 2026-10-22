/**
 * Settings the server and the worker cannot run in production without.
 *
 * SESSION_SECRET signs the login cookies and is also the key behind the stored
 * mailbox and bank secrets (encryption.ts). A process without it must stop
 * rather than fall back to the development secret that is in the source.
 */
export const MIN_SESSION_SECRET_LENGTH = 32;

export function assertStartupEnv(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const secret = env.SESSION_SECRET?.trim();
  if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be configured with at least ${MIN_SESSION_SECRET_LENGTH} characters in production`
    );
  }
}
