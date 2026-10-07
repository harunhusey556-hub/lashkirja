import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { writeEvents, type LoggedEvent } from "@/lib/event-log";

/**
 * The app's debugging trail (screens, requests, problem reports), sent in
 * batches and written to the event log next to the server's own errors
 * (lib/event-log.ts). Ids and actions only; the app sends no amounts or bodies.
 */

const text = (max: number) => z.string().max(max).optional();

const eventSchema = z.object({
  ts: z.string().max(40),
  kind: z.string().min(1).max(40),
  name: text(200),
  screen: text(200),
  method: text(10),
  path: text(300),
  status: z.number().int().min(0).max(999).optional(),
  durationMs: z.number().int().min(0).max(3_600_000).optional(),
  requestId: text(64),
  message: text(1000),
});

const bodySchema = z.object({
  sessionId: z.string().min(1).max(64),
  app: z.object({ version: text(40), build: text(40), os: text(40) }).optional(),
  events: z.array(eventSchema).min(1).max(200),
});

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  // A batch every ~30 s plus problem reports fits easily; a runaway loop does not.
  const rate = consumeRateLimit(`event-log:${session.userId}`, 120, 10 * 60_000);
  if (!rate.allowed) return noStoreJson({ ok: true, dropped: true });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return noStoreJson({ error: "Virheellinen pyyntö" }, { status: 400 });
  const { sessionId, app, events } = parsed.data;

  const rows: LoggedEvent[] = events.map(({ ts, ...event }) => ({
    source: "ios",
    clientTs: ts,
    userId: session.userId,
    sessionId,
    app: app ? `${app.version ?? "?"}(${app.build ?? "?"}) ios=${app.os ?? "?"}` : undefined,
    ...event,
  }));
  for (const event of events) {
    if (event.kind === "report") {
      // Visible in the web log too, so a report is found even without the query tool.
      console.error(`[problem-report] ${event.name ?? "?"} user=${session.userId} ${event.message ?? ""}`);
    }
  }
  await writeEvents(rows);
  return noStoreJson({ ok: true, received: events.length });
}
