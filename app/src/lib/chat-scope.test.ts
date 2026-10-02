import { describe, expect, it } from "vitest";
import { offTopicRequest, replyLooksLikeCode, scopeLanguage, scopeRefusal } from "./chat-scope";

describe("the assistant stays on the books", () => {
  it("turns away code and writing requests in every language it speaks", () => {
    for (const text of [
      "html kod yaz",
      "Bana bir HTML sayfası yazar mısın?",
      "write me some javascript",
      "Can you write a Python script to sort a list?",
      "Kirjoita HTML-sivu",
      "tee minulle css-tiedosto",
      "kirjoita runo kissasta",
      "write a poem about spring",
      "bir şiir yaz",
      "write an essay about history",
      "<html><body>test</body></html> korjaa tämä",
    ]) {
      expect(offTopicRequest(text), text).toBe(true);
    }
  });

  it("lets bookkeeping questions through, including ones that say write or code", () => {
    for (const text of [
      "Kirjoita lasku asiakkaalle Anna",
      "Paljonko ALV:ta maksan tässä kuussa?",
      "Mikä on viitenumero?",
      "Mikä on ALV-koodi 14 %?",
      "Kuinka kirjaan kuitin?",
      "how do I write an invoice?",
      "fatura nasıl yazılır",
      "Mikä on tilikoodi 4000?",
      "Mitä tarkoittaa alv-kanta?",
      "Lähetä muistutus",
    ]) {
      expect(offTopicRequest(text), text).toBe(false);
    }
  });

  it("recognises code in a reply", () => {
    expect(replyLooksLikeCode("Tässä:\n```html\n<div>hei</div>\n```")).toBe(true);
    expect(replyLooksLikeCode("<!DOCTYPE html><html><head></head></html>")).toBe(true);
    expect(replyLooksLikeCode("<script>alert(1)</script>")).toBe(true);
    expect(replyLooksLikeCode("def total(rows):\n    return sum(rows)")).toBe(true);
    expect(replyLooksLikeCode("ALV on **25,5 %**. Katso ALV-ilmoitus.")).toBe(false);
    expect(replyLooksLikeCode("Summa < 100 € ja > 50 €")).toBe(false);
  });

  it("says no in the user's language and says what it can do", () => {
    expect(scopeRefusal("fi")).toMatch(/kirjanpi/i);
    expect(scopeRefusal("en")).toMatch(/bookkeeping/i);
    expect(scopeRefusal("tr")).toMatch(/muhasebe/i);
  });
});

describe("the refusal's language", () => {
  it("hears Turkish in a short code request", () => {
    expect(scopeLanguage("html kod yaz", "fi")).toBe("tr");
    expect(scopeLanguage("kirjoita runo", "fi")).toBe("fi");
    expect(scopeLanguage("write a poem", "en")).toBe("en");
  });
});
