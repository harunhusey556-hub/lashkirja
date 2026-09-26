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
| `CRON_SECRET` | Suojaa cron-reitit (`/api/cron/sync-bank` vaatii aina Bearer-avaimen) | – |
| `ENABLEBANKING_ENABLED` | `true` kytkee oikean PSD2-pankkiyhteyden | `false` |
| `ENABLEBANKING_APP_ID` | Enable Banking -sovelluksen id (`kid`) | – |
| `ENABLEBANKING_KEY_FILE` | RSA-yksityisen avaimen polku, ei repossa | – |
| `ENABLEBANKING_KEY_PEM` | Vaihtoehto tiedostolle: PEM tai sen base64 (vain deploy-secret) | – |
| `ENABLEBANKING_REDIRECT_URL` | Paluuosoite, täsmälleen sama kuin Control Panelin whitelistissä | – |
| `ENABLEBANKING_API_BASE` | API-juuri | `https://api.enablebanking.com` |

## Pankkiyhteys (Enable Banking)

Asetukset → Pankkiyhteys yhdistää oikean suomalaisen pankin (esim. Holvi tai Säästöpankki) PSD2-tilitietorajapintaan. Käyttäjä valitsee pankin, kirjautuu pankin sivulla ja palaa sovellukseen. Tapahtumat kirjoitetaan samoihin tiliotteisiin kuin tiedostotuonti. Tiedoston lataus säilyy.

Mock-pankki ei ole tuotantopolku. Sandbox- ja production-sovellukset ovat Enable Bankingissa erillisiä, ja sama koodi käy molempiin kun ympäristömuuttujat osoittavat oikeaan sovellukseen.

1. Luo sovellus [Enable Banking Control Panelissa](https://enablebanking.com/sign-in/) (sandbox kokeiluun, production oikeaan pankkiin).
2. Luo RSA-avain ja sertifikaatti. Lataa sertifikaatti paneeliin ja ota talteen Application ID.
3. Lisää whitelist-ohjausosoite täsmälleen samaan muotoon kuin `ENABLEBANKING_REDIRECT_URL`, esim. `https://oma-osoite.example/bank/callback`. Localhost kelpaa vain jos paneeli hyväksyy sen; muuten tarvitaan HTTPS-tunneli.
4. Pidä yksityinen avain repon ulkopuolella (`ENABLEBANKING_KEY_FILE`). Ilman tiedostojärjestelmää (esim. Vercel) laita PEM tai sen base64 `ENABLEBANKING_KEY_PEM`-secretiin. Avainta ei logiteta eikä palauteta selaimeen.
5. Aseta `ENABLEBANKING_ENABLED=true`, `ENABLEBANKING_APP_ID` ja paluuosoite. Käynnistä sovellus uudelleen.
6. Asetuksissa valitse yritystili tai henkilötili, sitten pankki. Uudet IBAN-tilit ovat oletuksena kirjanpidon ulkopuolella — valitse oma tili ennen hakua.
7. Ajasta `GET /api/cron/sync-bank` noin kuuden tunnin välein otsikolla `Authorization: Bearer $CRON_SECRET`. Ilman avainta reitti vastaa 401. Paikallinen `npm run worker` käyttää samaa 6 tunnin rajaa. Käyttäjän “Synkronoi nyt” lähettää selaimen PSU-otsikot, cron ei.

Istunnon eväste on `SameSite=Lax`, joten pankin paluu selaimessa toimii. iOS-sovelluksen sisäinen selain ja syvälinkki eivät ole vielä mukana: pankkiyhteys on ensin verkkoselaimessa.

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
