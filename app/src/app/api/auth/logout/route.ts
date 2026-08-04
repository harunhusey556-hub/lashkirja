import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { redirectResponse, sessionOptions, type SessionData } from "@/lib/session";
import { rejectCrossSite } from "@/lib/http-security";

export async function POST(req: NextRequest) {
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const res = redirectResponse("/login");
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  session.destroy();
  return res;
}
