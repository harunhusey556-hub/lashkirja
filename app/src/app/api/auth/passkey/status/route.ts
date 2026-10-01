import { NextResponse } from "next/server";
import { passkeyStatus } from "@/lib/passkey-config";

/** Public: whether passkeys are configured on this server. Says nothing about
 * any account. The login screen hides the passkey button when it is off. */
export async function GET() {
  const response = NextResponse.json(passkeyStatus());
  response.headers.set("Cache-Control", "no-store");
  return response;
}
