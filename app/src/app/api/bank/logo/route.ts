import { NextRequest, NextResponse } from "next/server";
import { fetchBankLogo, logoSourceUrl } from "@/lib/enablebanking/logo";
import { noStoreJson } from "@/lib/http-security";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** GET /api/bank/logo?src=<Enable Banking logo URL>: the image bytes, for a blob: URL. */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session?.userId) {
    return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  }
  const src = req.nextUrl.searchParams.get("src") ?? "";
  if (!logoSourceUrl(src)) {
    return noStoreJson({ error: "Logon osoite ei kelpaa." }, { status: 400 });
  }
  const image = await fetchBankLogo(src);
  if (!image) {
    return noStoreJson({ error: "Logoa ei saatu." }, { status: 404 });
  }
  return new NextResponse(image.bytes as BodyInit, {
    headers: {
      "Content-Type": image.contentType,
      "Cache-Control": "private, max-age=604800, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
