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
| `MAIL_TRANSPORT` | `json` = testilähetys (ei avaa yhteyttä), muuten SMTP | – |
| `CRON_SECRET` | Suojaa cron-reitit. `/api/cron/sync-bank` vaatii aina Bearer-avaimen | – |
| `ENABLEBANKING_ENABLED` | `true` kytkee oikean PSD2-pankkiyhteyden | `false` |
| `ENABLEBANKING_APP_ID` | Enable Banking -sovelluksen id (`kid`) | – |
| `ENABLEBANKING_KEY_FILE` | RSA-yksityisen avaimen polku, ei repossa | – |
| `ENABLEBANKING_KEY_PEM` | Vaihtoehto tiedostolle: PEM tai sen base64 (vain deploy-secret) | – |
| `ENABLEBANKING_REDIRECT_URL` | Paluuosoite, täsmälleen sama kuin Control Panelin whitelistissä | – |
| `ENABLEBANKING_API_BASE` | API-juuri | `https://api.enablebanking.com` |

## Pankkiyhteys (Enable Banking)

Asetukset → Pankkiyhteys yhdistää oikean suomalaisen pankin (esim. Holvi tai Säästöpankki) PSD2-tilitietorajapintaan. Käyttäjä valitsee pankin, kirjautuu pankin sivulla ja palaa sovellukseen. Tapahtumat kirjoitetaan samoihin tiliotteisiin kuin tiedostotuonti. Tiedoston lataus säilyy.

Tämä on eri asia kuin kohdan Pankkitilit kirjanpitotilit: `ConnectedAccount` on pankin palauttama IBAN, `BankAccount` on kuukausisaldon ja täsmäytyksen tili.

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

## Pankkitilit ja kuukausisaldot

- Jokainen pankkitili lisätään erikseen (nimi, IBAN, alkusaldo ja avauspäivä). IBAN tarkistetaan
  oikealla ISO 13616 mod-97 -laskennalla, joten yksikin väärä numero ei mene läpi.
- Tiliote kohdistetaan tilille automaattisesti: käyttäjän valinta > tiedostosta löytyvä IBAN >
  oletustili.
- `/pankkitilit` näyttää kuukausittain alkusaldon, tulot, menot, lasketun loppusaldon ja pankin
  ilmoittaman loppusaldon. Ero jää näkyviin (`Ero`-merkintä) eikä sitä sulauteta pois.
- Seuraava kuukausi ankkuroidaan pankin ilmoittamaan saldoon, jos sellainen on kirjattu, jottei
  yksi selvittämätön kuukausi siirrä kaikkia myöhempiä saldoja.

## Asiakkaat ja myyntilaskut

- Asiakasrekisteri (`/asiakkaat`): Y-tunnus tarkistetaan mod-11-laskennalla, maksuaika per asiakas,
  avoin saldo asiakaskohtaisesti.
- Myyntilaskut (`/laskut`): rivit, ALV-kannat, viitenumero (7-3-1 mod 10), tilat
  luonnos → lähetetty → maksettu / hyvitetty. Vain luonnosta voi muokata tai poistaa.
- ALV lasketaan kantakohtaisesta nettosummasta, ei riveittäin — sadan pienen rivin pyöristykset
  eivät voi siirtää loppusummaa.
- **Maksujen kohdistus:** `Kohdista maksut` lukee tuodut tilitapahtumat ja merkitsee maksun
  automaattisesti vain, jos tapahtuma kantaa laskun viitenumeron. Pelkkä summaosuma jää
  ehdotukseksi eikä kirjaudu kirjanpitoon.

## Ostolaskut

- `/ostolaskut` seuraa mitä olet velkaa ja milloin: toimittaja, eräpäivä, osamaksut, ikäjakauma.
- **Tarkoituksella pelkkä velkaseuranta.** ALV-raportti lasketaan edelleen kuiteista, joten sama
  osto ei kirjaudu kahdesti. Kun kuitti saapuu, liitä se ostolaskuun (`receiptId`).
- Maksujen kohdistus toimii kuten myynnissä: viitenumero-osuma kirjautuu automaattisesti,
  pelkkä summaosuma jää ehdotukseksi.

## Laskun PDF ja lähetys

- `Avaa PDF` tuottaa laskun palvelimella (pdfkit), joten asiakkaan kappale, sähköpostin liite ja
  arkistoitu tiedosto ovat samat tavut.
- PDF:llä on myös **virtuaaliviivakoodi** (versio 4), jonka asiakas voi skannata pankkiin.
  Koodi rakennetaan vain kelvollisesta suomalaisesta IBANista ja viitenumerosta — muuten se
  jätetään pois eikä arvata.
- `Lähetä sähköpostilla` käyttää samaa sähköpostitiliä, joka on jo yhdistetty kuittien hakua
  varten. Lasku merkitään lähetetyksi vasta kun postipalvelin on hyväksynyt viestin.
- Laskuttajan tiedot (nimi, Y-tunnus, osoite, IBAN, BIC, ehdot) syötetään Asetukset-sivulla.

## Toistuvat laskut

- `/toistuvat`: sama lasku samalle asiakkaalle kuukausittain, neljännesvuosittain tai vuosittain.
- Rivit ovat **pohja**: jokainen luotu lasku saa omat rivinsä, joten pohjan muokkaus ei muuta
  laskua, joka on jo asiakkaalla.
- Laskutuspäivä muistetaan: 31. päivä laskuttaa helmikuussa 28./29. ja maaliskuussa taas 31.
- Väliin jääneet kerrat luodaan, ei ohiteta — jos sovellus on ollut kiinni kolme kuukautta,
  syntyy kolme laskua omilla päivämäärillään (katto 24 kerralla).
- Luonti on **idempotenttia**: yksi kerta = yksi rivi `(aikataulu, laskun päivä)` -uniikilla
  avaimella, joten uusintayritys tai kaksi välilehteä ei laskuta kahdesti.
- Lukittu kausi ei kaada ajoa: se kerta merkitään ohitetuksi ja loput syntyvät normaalisti.
- Automaattilähetys on best-effort: lasku on aina tallessa, epäonnistunut lähetys raportoidaan.
- Ajastus: `GET /api/cron/recurring-invoices` (vaatii `CRON_SECRET`-bearerin tai `?secret=`).

## Maksumuistutukset ja viivästyskorko

- Myöhässä olevalle laskulle voi luoda maksumuistutuksen: avoin pääoma + viivästyskorko +
  muistutusmaksu, omana PDF:nään ja sähköpostina.
- **Korkoa ei arvata.** Viivästyskorko on Suomen Pankin viitekorko + 7 (kuluttaja) tai + 8
  (yritys) prosenttiyksikköä, ja viitekorko vaihtuu puolivuosittain. Sovellus ei kovakoodaa
  sitä: syötä korko Asetuksissa, muuten korkoa ei peritä lainkaan.
- Korko lasketaan eräpäivää seuraavasta päivästä, todellisilta päiviltä, 365 päivän vuodella.
- Muistutus toistaa alkuperäisen viitenumeron, joten maksu kohdistuu edelleen oikealle laskulle.
- Muistutuksesta tallennetaan mitä sinä päivänä vaadittiin, joten summa on jälkikäteen
  todennettavissa. `/api/invoices/overdue` listaa työjonon: myöhässä olevat, pahin ensin.

## Kirjanpidon lukitus

- Asetuksissa voi sulkea kaudet valittuun kuukauteen asti. Sen jälkeen kyseisille kausille ei voi
  lisätä, muuttaa **eikä poistaa** kuitteja, tiliotteita, myynti- tai ostolaskuja, maksuja eikä
  kuukausisaldoja — poistaminen muuttaa jo annettua ALV-ilmoitusta yhtä paljon kuin muokkaus.
- Pankkikohdistus ei kaadu lukkoon: lukitulle kaudelle osuva viitenumero-osuma ohitetaan ja
  raportoidaan (`skippedLocked`), muut kohdistuvat normaalisti.
- Lukituksen voi avata uudelleen — korjaus on joskus pakko tehdä — mutta se on tietoinen teko.

## Raportit ja viennit

- `/raportit`: tuloslaskelma kuukausittain, menot ja tulot kategorioittain, netto ja brutto.
  Kuitit joilta puuttuu ALV-erittely lasketaan bruttona ja merkitään erikseen — kantaa ei arvata.
- CSV-viennit (kuitit, tilitapahtumat, myyntilaskut, asiakkaat): puolipiste-eroteltu, UTF-8 BOM,
  desimaalipilkku — avautuu suoraan Exceliin.

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

## Testit

```bash
npm test                 # yksikkötestit (puhtaat laskennat, validoinnit)
npm run test:integration # oikea SQLite-tiedosto + oikeat API-reitit + oikeat istuntoevästeet
npm run test:e2e         # Playwright: kirjautuminen, pankkitili, laskun elinkaari
npm run check            # lint + typecheck + kaikki testit + tuotantorakennus
```

Integraatiotestit ajavat jokaisen testitiedoston omaa migratoitua tietokantaa vasten
(`tests/integration/`), eivätkä käytä mockeja: vihreä ajo tarkoittaa, että HTTP-rajapinta
todella toimii.

## Tuotantorakennus

```bash
npm run build   # optimoitu tuotantorakennus
npm start       # käynnistä tuotantopalvelin
```
