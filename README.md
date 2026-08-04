# LashKirja

Yksinkertainen kirjanpitosovellus suomalaisille ripsiyrittäjille (toiminimi). AI-avusteinen kuittien lukeminen, tiliotteiden tuonti ja ALV-raportointi.

## Pika-asennus

```bash
cd app
cp .env.example .env        # muokkaa tarvittaessa
npm install
npx prisma migrate dev       # luo tietokanta
npx tsx prisma/seed.ts       # luo demokäyttäjät
npm run dev                  # käynnistä http://localhost:3000
```

## Demokäyttäjät

| Sähköposti | Salasana |
|---|---|
| demo@lashkirja.fi | demo123 |
| anna@lashkirja.fi | demo123 |

## Ympäristömuuttujat

| Muuttuja | Kuvaus | Oletus |
|---|---|---|
| `DATABASE_URL` | SQLite-polku | `file:../data/lashkirja.db` |
| `SESSION_SECRET` | Istunnon salaus (min 32 merkkiä) | dev-avain |
| `LLM_BASE_URL` | OpenAI-yhteensopiva API endpoint | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API-avain (tyhjä = OCR-varapolku) | – |
| `LLM_MODEL` | Malli | `gpt-4o-mini` |

## Kuittien analyysi

- **Tuetut muodot:** PDF, JPG, PNG, HEIC (iPhone-kuvat muunnetaan automaattisesti JPEG:ksi `heic-convert`-kirjastolla) + mobiilikameran suora kuvaus.
- **AI-polku:** LLM_API_KEY asetettuna → kuva/PDF lähetetään vision-mallille, joka palauttaa myyjä, päivämäärä, summa, ALV-erittely, kategoria JSON-muodossa.
- **GitHub Copilot -polku:** `COPILOT_GITHUB_TOKEN` (ghu_-token, esim. OpenClawin device-code-loginista) → token vaihdetaan automaattisesti lyhytikäiseen Copilot-sessiotokeniin ja dokumentin teksti (pdftotext / tesseract) analysoidaan `COPILOT_MODEL`-mallilla (oletus gpt-4o). Vision on monilla Copilot-tileillä policy-estetty, siksi tekstipohjainen analyysi. Uudemmat mallit (gpt-5.x, claude) vaativat mallin sallimisen GitHubin Copilot-asetuksista.
- **OCR-varapolku:** ilman API-avainta → tesseract (fin+eng) + `pdftotext -layout` + suomalaisiin laskuihin viritetty parseri (Lasku yhteensä / Maksettava EUR -prioriteetit, sarakelayout, ALV-rivien veroton×kanta-tarkistus). Vaatii: `tesseract-ocr`, `tesseract-ocr-fin`, `poppler-utils`.

## Tiliotteet

Tuetut muodot:
- **camt.052/053 XML** — ISO 20022 -standardi (Holvi, pankit)
- **XLSX** — sarakkeiden automaattinen tunnistus
- **CSV** — puolipisteellä tai pilkulla erotettu
- **PDF** — pdftotext + regex-parseri (Säästöpankki ym.)

## ALV-raportti

Suomen 2026 ALV-kannat:
- 25,5 % (yleinen, mm. ripsipalvelut)
- 13,5 % (ravintolat, kirjat, lääkkeet, majoitus, liikunta, kuljetus)
- 10 % (sanoma-/aikakauslehdet)
- 0 % (vienti, EU-myynti)

OmaVero-kentät 301/303/305/307/308.

## Tekninen pino

- Next.js 16 (App Router) + TypeScript + Tailwind CSS v4
- Prisma 7 + SQLite (libsql-adapteri)
- iron-session (istuntoevästeet)
- Ei ulkoisia riippuvuuksia palveluista — kaikki pyörii paikallisesti

## Tuotantorakennus

```bash
npm run build   # optimoitu tuotantorakennus
npm start       # käynnistä tuotantopalvelin
```
