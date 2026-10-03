import { NextResponse } from "next/server";
import { signupEnabled } from "@/lib/signup";

/** Public: whether new accounts can be created here. The app hides "Luo tili" when off. */
export async function GET() {
  const response = NextResponse.json({ enabled: signupEnabled() });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
