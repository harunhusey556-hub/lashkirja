import { describe, expect, it } from "vitest";
import { APP_GUIDE, CHAT_DESTINATIONS, asksToConnectBank, suggestedChatActions } from "./chat-app";
describe("assistant navigation", () => {
  it.each(["Bankamı nereden bağlayabilirim?", "Mistä yhdistän pankkini?", "How do I connect my bank?"])("offers verified bank setup for %s", question => {
    expect(asksToConnectBank(question)).toBe(true);
    expect(suggestedChatActions(question)).toContainEqual({ label: "Yhdistä pankki", href: "/kirjanpito/pankkitilit?connect=1", kind: "action" });
  });
  it("does not turn a balance question into a connect action answer", () => {
    expect(asksToConnectBank("What is my bank balance?")).toBe(false);
  });
  it("selects seller setup rather than creating an invoice for IBAN questions", () => {
    expect(suggestedChatActions("Mihin lisään laskuttajan IBANin?")[0].href).toBe("/asetukset/laskutus");
  });
});

describe("A6: every place the apps route to", () => {
  // The paths ios-native/LashKirjaCore/Sources/LashKirjaCore/Format/AppLink.swift parses.
  const NATIVE_PATHS = new Set([
    "/kuitit", "/kuitit/kuitti", "/pankki/tapahtumat", "/pankki/taydennys", "/pankki/tapahtumat/tiliote",
    "/kirjanpito/pankkitilit", "/kirjanpito/alv", "/alv-raportti", "/laskut", "/laskut/lasku", "/laskut/uusi",
    "/asiakkaat", "/asiakkaat/asiakas", "/kirjanpito/ostolaskut", "/toistuvat", "/kirjanpito/kaudet",
    "/kirjanpito/kuukausi", "/tyot", "/raportit", "/asetukset", "/asetukset/laskutus", "/asetukset/yritys",
    "/asetukset/profiili", "/asetukset/tietosuoja", "/asetukset/ohje", "/asetukset/sahkoposti", "/pankki",
    "/tiliotteet", "/pankki/tiliotteet", "/sahkoposti",
  ]);

  it("offers only destinations the native app can open", () => {
    for (const item of CHAT_DESTINATIONS) {
      expect(NATIVE_PATHS.has(item.href.split("?")[0]), item.href).toBe(true);
    }
  });

  it("knows purchase invoices, recurring invoices, the work queue, month close, email, bank and settings pages", () => {
    const hrefs = CHAT_DESTINATIONS.map((item) => item.href);
    for (const href of [
      "/kirjanpito/ostolaskut", "/toistuvat", "/tyot", "/kirjanpito/kuukausi", "/kirjanpito/kaudet",
      "/asetukset/sahkoposti", "/pankki", "/tiliotteet", "/kirjanpito/pankkitilit", "/asiakkaat", "/laskut",
      "/asetukset/yritys", "/asetukset/profiili", "/asetukset/tietosuoja", "/asetukset/ohje",
    ]) {
      expect(hrefs, href).toContain(href);
    }
    expect(APP_GUIDE).toMatch(/Ostolaskut: \/kirjanpito\/ostolaskut/);
    expect(APP_GUIDE).toMatch(/recurring purchase/i);
  });

  it.each([
    ["Fişi banka işlemiyle eşleştir", "/pankki/tapahtumat"],
    ["Kuitin kohdistus pankkitapahtumaan", "/pankki/tapahtumat"],
    ["Missä ostolaskut ovat?", "/kirjanpito/ostolaskut"],
    ["Alış faturalarım nerede?", "/kirjanpito/ostolaskut"],
    ["Where are my purchase invoices?", "/kirjanpito/ostolaskut"],
    ["Miten teen toistuvan laskun?", "/toistuvat"],
    ["Tekrarlayan fatura nasıl yapılır?", "/toistuvat"],
    ["Mikä tuonti epäonnistui?", "/tyot"],
    ["İçe aktarma hatası", "/tyot"],
    ["Miten suljen kuukauden?", "/kirjanpito/kuukausi"],
    ["How do I close the month?", "/kirjanpito/kuukausi"],
    ["Ay sonu kapanışı", "/kirjanpito/kuukausi"],
    ["Sähköpostituonti ei toimi", "/asetukset/sahkoposti"],
    ["E-posta ile fiş gönderme", "/asetukset/sahkoposti"],
    ["Mistä löydän tiliotteet?", "/tiliotteet"],
    ["Hesap ekstresi nerede?", "/tiliotteet"],
    ["Paljonko pankkitilillä on rahaa?", "/pankki"],
    ["Banka bakiyem ne kadar?", "/pankki"],
    ["Uusi asiakas", "/asiakkaat"],
    ["Müşteri ekle", "/asiakkaat"],
    ["Muuta yritysmuotoa", "/asetukset/yritys"],
    ["Tietosuoja", "/asetukset/tietosuoja"],
  ])("%s → %s", (question, href) => {
    expect(suggestedChatActions(question).map((item) => item.href)).toContain(href);
  });

  it("does not open bank connection for a matching or balance question", () => {
    expect(suggestedChatActions("Fişi banka işlemiyle eşleştir").map((item) => item.href)).not.toContain("/kirjanpito/pankkitilit?connect=1");
    expect(suggestedChatActions("Missä ostolaskut ovat?").map((item) => item.href)).not.toContain("/laskut/uusi");
  });
});
