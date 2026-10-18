# Phase 2 exploratory walk (audit only)

Branch `audit/phase2-walk`. It is never merged. The walk records what it reaches and does not judge it.

- **Test:** `ios-native/App/Tests/LashKirjaUITests/ExploratoryWalkTests.swift`
  - `final class ExploratoryWalkTests: WalkTestCase`, with `continueAfterFailure = true`.
  - Each method starts from a fresh `launchSignedIn()` with `-LKUITest`.
- **Data:** `demo-seed.ts --ci`, then `app/scripts/audit-seed.ts`. The audit seed is idempotent and adds:
  - two sure pairs ("Audit Tukku Oy" 87,65 € and "Audit Kahvila Oy" 34,50 €). Each pair matches on viite and exact amount, and each has a rival receipt so a matching run keeps it suggested;
  - an approved credit note "Audit Hyvitys Oy" (−50,00 €);
  - a pending credit note "Audit Hyvitys Odottaa Oy" (−18,90 €);
  - three free bank rows, "Audit Täyte 1–3".
- **CI:** `.github/workflows/ios-ui-suite.yml` on this branch.
  - The matrix is `[ExploratoryWalkTests]`, `fail-fast: false`, timeout 150 min.
  - It uses OwnerScreensTests' environment: the reader stub, `CLOUD_AI_ENABLED`, `LK_READER_STUB=1`.
  - The audit seed runs right after the demo seed and before the picture step.
  - Run it with `gh workflow run ios-ui-suite.yml --ref audit/phase2-walk` once the branch is pushed.

## Where the output is

Artifact `ui-screenshots-ExploratoryWalkTests`:
- `ui-attachments/named/<shot>.png`: the app screenshot, as an XCTAttachment.
- `ui-shots/<shot>.png`: the whole-device host PNG, with the same name.
- `ui-shots/notes.txt`: one PASS, FAIL, MISS or INFO line per step.
- `ui-shots/<name>-tree.txt`: the element tree, written on every FAIL or MISS.

Artifact `ui-result-ExploratoryWalkTests` holds `notes.txt` and `row.json`. Its FAIL and MISS lines also appear in the run summary.

Shot-name suffixes:
- `-auki`: menu open
- `-suljettu`: after closing
- `-peruttu`: confirm sheet answered Peruuta
- `-naytaenemman` / `-auki` / `-taitettu`: Näytä enemmän at start, fully open, folded
- `-vieritysN`: the next screenful
- `-ei-rivia`: the row to tap was missing
- `-2`, `-3`: a repeated name in the same run

## Checklist → method → shots

| Checklist item | Method | Main shots |
|---|---|---|
| Koti tab, month stepper, task rows, Muistuta sheet, Kuvaa kuitti cover, Rahatilanne, Hoidettu, Tuonnit | `test01_Koti` | `x01-koti`(+`-vieritys1..4`), `x01-koti-edellinen-kuukausi`, `x01-koti-tama-kuukausi`, `x01-koti-myohassa-lasku`, `x01-koti-muistuta`(+`-suljettu`), `x01-koti-kuvaa-kuitti`(+`-suljettu`), `x01-koti-rahatilanne-pankki`, `x01-koti-hoidettu-automaattisesti`, `x01-koti-tuonnit-ja-virheet` |
| Myynti tab: chips, Erittely, invoice tabs, 3-dot menus (overdue invoice, draft, customer, Asiakkaat +), sheets (PDF, Kirjaa maksu, Lähetä lasku, Hyvitä laskua, Sulje perustelulla, Muokkaa laskua, Uusi lasku + Valitse asiakas + line 3-dot, Uusi asiakas, Tuo asiakkaita, Muokkaa asiakasta, Yhdistä kaksoiskappale, Uusi toistuva lasku, Maksut pankista) | `test02_Myynti` | `x02-myynti`, `x02-myynti-luonnokset`, `x02-myynti-erittely`, `x02-lasku-myohassa`(+`-rivit/-maksut/-historia/-muistutus`), `x02-lasku-3dot-menu-auki/-suljettu`, `x02-lasku-pdf`, `x02-lasku-kirjaa-maksu`, `x02-lasku-laheta`, `x02-lasku-hyvita`, `x02-lasku-sulje-perustelulla`, `x02-lasku-luonnos`, `x02-luonnos-3dot-menu-*`, `x02-luonnos-muokkaa`, `x02-uusi-lasku`(+`-valitse-asiakas`, `-rivi-3dot-menu-*`), `x02-asiakkaat`, `x02-asiakkaat-plus-menu-*`, `x02-asiakkaat-uusi-asiakas`, `x02-asiakkaat-tuo-csv`, `x02-asiakas`, `x02-asiakas-3dot-menu-*`, `x02-asiakas-muokkaa`, `x02-asiakas-yhdista`, `x02-toistuvat`, `x02-toistuvat-uusi`, `x02-toistuva-kuukausiyllapito`, `x02-maksut-pankista` (each sheet also `-suljettu`) |
| Kuitit: every chip, filter menu + Summarajaus, select mode + bar, row swipe, receipt 3-dot menu, delete question, Muokkaa kuittia, Näytä kuitti, bank picker | `test03_Kuitit` | `x03-kuitit`, `x03-kuitit-chip-all/-tulo/-meno/-linked/-unlinked/-laskut`, `x03-kuitit-suodatin-menu-*`, `x03-kuitit-summarajaus`(+`-peruttu`), `x03-kuitit-valinta`, `x03-kuitit-valinta-palkki`, `x03-kuitit-valinta-pois`, `x03-kuitit-rivi-pyyhkaisy`(+`-kiinni`), `x03-kuitti`, `x03-kuitti-3dot-menu-*`, `x03-kuitti-poista`(+`-peruttu`), `x03-kuitti-muokkaa`, `x03-kuitti-nayta`, `x03-pankkivalitsin`(+`-suljettu`) |
| Upload → review → link | `test04_UploadReviewLink` | `x04-uusi-kuitti`, `x04-lahetetaan`, `x04-lomake`, `x04-lomake-taytetty`, `x04-tallennettu`, `x04-jono-3dot-menu-*`, `x04-jono-lisaa-tiedostoja-auki/-suljettu`, `x04-jono-suljettu`, `x04-kuitit-tallennettu-rivi`, `x04-tarkistus`, `x04-pankkivalitsin`, `x04-pankkivalitsin-haku`, `x04-kohdistetaanko`, `x04-kohdistettu`, `x04-kuitit-lopuksi` |
| "Kohdista varmat" → "Kumoa" | `test05_SureMatchesUndo` | `x05-kohdista-varmat`, `x05-kumottu`, `x05-kohdista-varmat-taas`, `x05-kohdistettu-toast` (attachment only), `x05-kumottu-toinen`, `x05-lopuksi` |
| Credit note (hyvitys) receipt | `test06_CreditNote` | `x06-hyvitys-rivi`, `x06-hyvitys-kuitti`(+`-vieritys1`), `x06-hyvitys-3dot-menu-*`, `x06-tarkastettavat`, `x06-hyvitys-odottaa` |
| Raportit tab (year stepper, Menot/Tulot drills, Luokittain, zip, CSV) | `test07_Raportit` | `x07-raportit`(+`-vieritys1..4`), `x07-raportit-edellinen-vuosi`, `x07-menot-kuitit`, `x07-tulot`, `x07-luokittain-tulot/-menot`, `x07-lataa-zip`, `x07-csv-tuloslaskelma` |
| Pankki (Kirjanpito hub, Pankki, Pankkitapahtumat calendar + 3-dot menus, a bank row sheet, accounts, Uusi pankkitili, Tiliotteet, a statement + 3-dot) | `test08_Pankki` | `x08-kirjanpito`, `x08-pankki`, `x08-pankkitapahtumat`, `x08-pankkitapahtumat-kalenteri-menu-*`, `x08-pankkitapahtumat-3dot-menu-*`, `x08-pankkitapahtumat-vaatii-toimia`, `x08-pankkirivi`, `x08-pankkiyhteys`, `x08-tili`, `x08-uusi-tili`, `x08-tiliotteet`, `x08-tiliote`, `x08-tiliote-3dot-menu-*` |
| Chat (Avustaja sheet, attach menu, Keskustelut) | `test09_Chat` | `x09-avustaja`, `x09-avustaja-liite-menu-*`, `x09-keskustelut`, `x09-keskustelut-arkisto`, `x09-avustaja-suljettu` |
| Asetukset > Laitteet | `test10_Asetukset_Laitteet` | `x10-asetukset`, `x10-laitteet`, `x10-laitteet-lista`, `x10-kaikki-muut`(+`-peruttu`), `x10-laite-pyyhkaisy`, `x10-laite-kirjaa-ulos`(+`-peruttu`), `x10-laite-vahvistus`, `x10-laite-kirjattu-ulos`, `x10-asetukset-lopuksi-suljettu` |
| Sign out → sign in | `test11_SignOutIn` | `x11-asetukset`, `x11-kirjaudu-ulos`(+`-peruttu`), `x11-kirjautuminen`, `x11-vaara-salasana`, `x11-kirjautunut-taas` |
| Offline on three screens, then recovery | `test12_Offline` | `x12-myynti-verkossa`, `x12-myynti-offline`, `x12-ostolaskut-offline`, `x12-asetukset-offline`, `x12-laitteet-offline`, `x12-laitteet-takaisin-verkossa`, `x12-ostolaskut-takaisin-verkossa`, `x12-myynti-takaisin-verkossa` |
| Lisää tab (sheet, Uusi myyntilasku, Lisää tiedosto, Yhdistä sähköposti, Tuo tiliote picker) | `test13_LisaaSheet` | `x13-lisaa`(+`-suljettu`), `x13-uusi-lasku`, `x13-lisaa-tiedosto`, `x13-yhdista-sahkoposti`, `x13-lisaa-takaisin`, `x13-tuo-tiliote`(+`-peruttu`) |
| Every other Asetukset row and its sheets | `test14_AsetuksetRows` | `x14-asetukset`(+`-vieritys1..3`), `x14-profiili`, `x14-yritysmuoto`, `x14-laskuttaja`, `x14-sahkopostimallit`(+`-uusi-malli`), `x14-maksut`, `x14-sahkopostien-tuonti`(+`-yhdista`), `x14-vaihda-salasana`, `x14-vaihda-sahkoposti`, `x14-paasyavaimet`, `x14-sovelluslukitus`, `x14-ilmoitukset`, `x14-tietosuoja`, `x14-ohje`, `x14-ilmoita-ongelmasta` |
| Kirjanpito's other screens (Ostolaskut + its 3-dot menu and sheets, Sähköposti, Kohdista kuitit, Kohdista ostolaskujen maksut, Kuukauden sulku, ledger parts) | `test15_KirjanpitoMuut` | `x15-ostolaskut`, `x15-uusi-ostolasku`, `x15-ostolasku`, `x15-ostolasku-3dot-menu-*`, `x15-ostolasku-kirjaa-maksu/-kohdista/-hyvita`, `x15-sahkoposti`, `x15-kohdista-kuitit`, `x15-kohdista-ostolaskut`, `x15-kuukauden-sulku`, `x15-kirjanpito-tulos/-tase/-saldot/-paivakirja` |
| ALV-ilmoitus | `test16_Alv` | `x16-alv-1..3`, `x16-alv-takaisin` |

**Näytä enemmän.** These lists are opened in full and then folded back:
- Koti "Tarvitaan sinulta" (x01)
- Myynti (x02), Asiakkaat (x02), Toistuvat laskut (x02)
- Kuitit (x03) and the bank picker (x03)
- Raportit categories (x07)
- Pankkitapahtumat (x08), Tiliotteet (x08) and the 26-row statement (x08)
- Keskustelut (x09)
- Ostolaskut and Sähköposti (x15)

The demo seed makes only Kuitit, the bank picker, Pankkitapahtumat and the 26-row statement longer than one step. On those four lists a missing button is a FAIL. On the others the walk notes `INFO … no Näytä enemmän`.

## Order and shared state

The methods share one demo DB and one install, and they run in name order. Four of them change what the later ones see:
- x04 saves a receipt and links it to "Audit Täyte 2".
- x05 links the two sure pairs and takes them back, twice.
- x10 really signs out the CI's "Selain" session.
- x11 signs the app out and back in, with one wrong password.

Nothing else is confirmed. Every other question is answered Peruuta, and every form is closed unchanged.

## Not covered, and why

- **"Hyväksytty automaattisesti" on an auto-saved queue row, and a credit note made through capture.** The reader stub always returns the same bill, with no date and `isCreditNote` false. The credit notes are therefore seeded instead.
- **The system pickers ("Valitse kuvista", "Valitse tiedosto") and the camera.** XCTest cannot drive the system pickers, and the simulator has no camera. Only the "Tuo tiliote" picker is opened, and it is closed with its own Cancel.
- **The "Valitse kausi" menu on ALV-ilmoitus, and any query on that screen.** Reading the screen's element tree runs past XCTest's snapshot timeout in a Debug build (StabilityTests.test04), so the screen gets shots only.
- **The "Ei verkkoyhteyttä" banner.** The walk's proxy can only make the server unreachable ("Palvelimeen ei saada yhteyttä"). The phone's own network stays up.
- **Korttimaksu / POS and the Stripe states in Maksut.** The demo API has no Stripe keys.
- **Bank-connection rows, passkey creation and the Face ID toggles.** Banking is disabled in CI, WebAuthn is not configured, and the simulator has no enrolled biometrics.
- **Actions that write.** These are never confirmed: deleting, Merkitse lähetetyksi, Kopioi luonnokseksi, Hyvitä, Luo lasku nyt, Kirjaa maksut, sending a reminder or an invoice, a password or email change, the account requests, and setting a PIN.
- **The Koti pills Hyväksy, Täydennä and Kohdista, the review queue's "Näytä kaikki", and Hylätyt.** The data has at most one pending receipt and no rejected one.
- **Not checked here:**
  - The Swift test was not compiled. This is a Windows host and Xcode only runs on the CI macOS runner, so the first CI run is also the first compile.
  - The seed was checked locally on a throwaway SQLite file:
    - Two runs give the same rows.
    - `listSureMatches` returns 2 both before and after `runMatching`.
    - Link then undo works twice in a row.
    - `tsc --noEmit` and `eslint` pass.
