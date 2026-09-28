"use client";

import { useSession } from "@/components/SessionProvider";

/** The signed-in user's id, from the shared session source (Task 6) --
 * no longer its own `/api/auth/me` call. */
export function useAccountId(): string | null {
  const { user } = useSession();
  return user?.userId ?? null;
}
