# LashKirja — SPEC v1

Minimal AI-powered bookkeeping (kirjanpito) web app for Finnish lash technicians (small businesses / toiminimi). First version is for a small circle of friends. Must be simple, polished, and reliable.

## Stack (keep it boring and solid)
- Next.js (App Router) full-stack, TypeScript, Tailwind CSS.
- SQLite via Prisma (single-file DB, zero ops).
- Local file storage for uploads: `data/uploads/`.
- Runs with `npm run dev`; production build must also pass (`npm run build`).

## Pages / Flow
1. **Login** — simple email + password, session cookie (iron-session or similar). Seed 2 demo users (e.g. `demo@lashkirja.fi` / `demo123`). No public registration needed in v1 (admin seeds users).
2. **Dashboard** (after login)
   - Time-of-day greeting in Finnish: 05–10 "Huomenta, {etunimi}!", 10–17 "Hyvää päivää, {etunimi}!", 17–23 "Hyvää iltaa, {etunimi}!", else "Hyvää yötä, {etunimi}!".
   - Simple stats for current month: tulot (income), menot (expenses), kuittien määrä, arvioitu ALV (maksettava/palautettava).
   - Hamburger menu (top-left or top-right) → navigation to all pages.
3. **Kuitit & laskut** — upload receipts/invoices:
   - File upload (PDF/JPG/PNG/HEIC) + mobile camera capture (`<input type="file" accept="image/*" capture="environment">`).
   - AI analyzes each upload → extracted fields: myyjä (vendor), päivämäärä, summa yhteensä, ALV-erittely (rate → amount), kategoria (suggested from a fixed list: tarvikkeet, vuokra, markkinointi, matkakulut, puhelin/netti, koulutus, muut), tulo/meno.
   - Show extracted data in an editable form → user confirms → saved to DB with link to original file.
   - List view of all saved receipts, newest first, with month filter.
4. **Tiliotteet** — upload bank statements:
   - Accept PDF, camt.052/053 XML, XLSX, CSV.
   - Parse transactions (date, counterparty, amount, reference/message). For PDF use text extraction (pdfplumber-style via pdf-parse or similar JS lib); for camt XML parse properly; for XLSX/CSV map columns.
   - Transaction list per statement; each transaction taggable as tulo/meno/oma siirto (ignore).
5. **ALV-raportti**
   - Select period (month or quarter).
   - Compute: myynnin ALV per rate, vähennettävä ALV (from receipts), maksettava/palautettava ALV.
   - Finnish VAT rates 2026 (verified vero.fi): yleinen **25,5 %**, alennettu **13,5 %** (food, restaurants, books, medicine, sports, transport, accommodation since 2026-01-01), **10 %** (newspapers/magazines), **0 %** (exports, EU sales). Lash services = 25,5 %.
   - Output styled like OmaVero fields: 301/303/305 (myynti per rate), 307 (vähennettävä), 308 (maksettava/palautettava).
   - Show plainly with figures; export as PDF optional (nice-to-have).

## AI integration (photo/receipt analysis)
- Implement one `lib/ai.ts` client using **OpenAI-compatible chat completions** API. Config via env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (default `gpt-4o-mini`). Vision: image as base64 data URL in message content.
- Intended production backend: GitHub Copilot provider proxy (OpenAI-compatible) with a cheap vision model (gpt-4o / gpt-5-mini class). Endpoint gets wired via env later — DO NOT hardcode a provider.
- **Fallback path (must work offline):** if `LLM_API_KEY` empty → use tesseract OCR (installed on this machine: fin/swe/eng) via `child_process` + regex parsing of Finnish receipts (YHTEENSÄ/Yhteensä, ALV %-breakdown lines, comma decimals, date formats dd.mm.yyyy). Wrap so UI doesn't care which path ran; mark result `source: "ai" | "ocr"` and confidence.
- Prompt for AI extraction must demand strict JSON (give schema in prompt), parse defensively.

## UI / design
- Language: **Finnish** everywhere.
- Minimalist, mobile-first, soft aesthetic suitable for beauty-industry users: warm neutral palette (e.g. cream/blush/charcoal), generous whitespace, rounded cards, one accent color. No cluttered admin-dashboard look.
- Loading/empty/error states everywhere; uploads show progress and never leave user stuck.

## Test data (real, on this machine — use for E2E verification)
- Receipts (photos/PDFs): `/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/kirjanpito/2026/05-mayis/kuitit/`
- Bank statement camt XML: `/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/kirjanpito/2026/05-mayis/tiliote/camt052_2026-05.xml`
- Bank statement XLSX: `/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/kirjanpito/2026/05-mayis/tiliote/mayis_2026_tiliote.xlsx`
- Bank statement PDFs: `/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/kirjanpito/saastopankki-tiliotteet/ctr/` (Säästöpankki monthly PDFs)
- Test with at least 3 receipts + 1 camt XML + 1 PDF tiliote. Use OCR fallback if no LLM key present.

## Deliverables
- App in `app/` subfolder of this project directory.
- `README.md`: setup, env vars, run, seed users.
- `TESTIRAPORTTI.md`: what was tested with the real sample files above, per-file parse results (vendor/date/total found or not), known limitations.
- All code committed-ready (no secrets in repo, `.env.example` provided).

## Non-goals v1
- No Merit/OmaVero integration, no e-invoicing, no multi-tenant billing, no registration flow, no cloud deploy.
