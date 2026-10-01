import { NextResponse } from "next/server";
import { appleAppSiteAssociation } from "@/lib/passkey-config";

/**
 * Apple's associated-domains file. iOS (via Apple's CDN) fetches it from
 * https://<WEBAUTHN_RP_ID>/.well-known/apple-app-site-association before the
 * app may use passkeys for that domain. It must be JSON, served directly
 * (no redirect) and without auth; proxy.ts lists this path as public.
 */
export async function GET() {
  const body = appleAppSiteAssociation();
  if (!body) {
    return NextResponse.json({ error: "Not configured" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
