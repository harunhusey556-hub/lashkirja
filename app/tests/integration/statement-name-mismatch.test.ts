/**
 * 2026-10-09, from the phone: eleven statement files refused with "Tiedoston sisältö ja
 * tiedostopääte eivät vastaa toisiaan". A statement is read by its content, whatever its name.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { POST as uploadReceipt } from "@/app/api/receipts/route";
import { createBankAccountRow, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  await createBankAccountRow(user.id, { name: "Holvi", iban: "FI2112345600000785", isDefault: true });
});

afterAll(() => {
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

function upload(body: string, name: string) {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "application/octet-stream" }));
  return uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
}

describe("POST /api/statements with a name that does not match the content", () => {
  it("reads a CSV named .txt or .xls as CSV", async () => {
    const first = await upload("Kirjauspäivä;Summa;Saaja\n05.01.2026;120,00;Asiakas Oy\n", "Holvi-tiliote.txt");
    expect(first.status).toBe(200);
    expect((await readJson(first)).statement.fileType).toBe("csv");
    const second = await upload("Kirjauspäivä;Summa;Saaja\n06.01.2026;-45,00;Kauppa Oy\n", "export.xls");
    expect(second.status).toBe(200);
    expect((await readJson(second)).statement.fileType).toBe("csv");
  });

  it("reads a UTF-16 CSV (Excel's Unicode text) and one with CR line ends (audit 2026-10-09)", async () => {
    const text = "Kirjauspäivä;Summa;Saaja\r\n07.01.2026;-12,50;Kahvila Oy\r\n";
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const form = new FormData();
    form.set("file", new File([utf16], "tiliote.csv", { type: "text/csv" }));
    const first = await uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
    expect(first.status).toBe(200);
    expect((await readJson(first)).count).toBe(1);
    const crOnly = await upload("Kirjauspäivä;Summa;Saaja\r08.01.2026;-3,20;Kioski Oy\r", "vanha-mac.csv");
    expect(crOnly.status).toBe(200);
  });

  it("still refuses a receipt whose name and content disagree", async () => {
    const form = new FormData();
    form.set("file", new File(["%PDF-1.4\n%%EOF"], "kuitti.jpg", { type: "image/jpeg" }));
    const response = await uploadReceipt(buildFormRequest("/api/receipts", form, { cookie }));
    expect(response.status).toBe(415);
  });
});
