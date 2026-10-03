import { NextRequest } from "next/server";
import { onboardingAppUrl, onboardingState } from "@/lib/pos-payments";

/**
 * Where Stripe sends the owner back after onboarding. No session: it carries
 * no data and changes nothing. It answers a 302 to the app's fixed
 * lashkirja://pos/onboarding link (only state=return|refresh; anything else is
 * "return", so there is no open redirect), which ends the app's
 * ASWebAuthenticationSession. The HTML body is for a browser that does not
 * follow a custom-scheme redirect.
 */
export function GET(req: NextRequest): Response {
  const target = onboardingAppUrl(onboardingState(req.nextUrl.searchParams.get("state")));
  const html =
    `<!doctype html><html lang="fi"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>LashKirja</title></head><body style="font-family:system-ui,sans-serif;padding:24px">` +
    `<p><a href="${target}">Palaa LashKirjaan</a></p></body></html>`;
  return new Response(html, {
    status: 302,
    headers: {
      Location: target,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
