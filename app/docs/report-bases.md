# Raporttien pohjat

Samat rivit eivät ole sama luku. Ero on tarkoituksellinen.

- **Tuloslaskelma** laskee hyväksytyt kuitit. Luonnoskuitti ja myyntilasku ilman kuittia eivät ole tuloksessa.
- **ALV** laskee hyväksytyt kuitit ja lähetetyt tai maksetut myyntilaskut. Luonnoslasku ja hyvityslasku eivät ole ALV-luvussa. Kuitti, jonka sama tilitapahtuma on jo kohdistettu laskulle, jätetään pois ettei vero tule kahdesti.
- **Etusivun tulot ja menot** käyttävät tiliotteen kohdekuukautta (`periodMonth`), kun tiliote on olemassa. Ilman tiliotetta luku tulee kuiteista. Kohdekuukausi voi poiketa tapahtuman kirjauspäivästä, jos käyttäjä siirtää tiliotteen.
- **Laskujen yhteissumma** on laskujen oma kanta (luonnos, lähetetty, maksettu). Se ei ole tulos eikä ALV.

Kalenteripäivä tallennetaan UTC-keskiyönä. Kuukausi on sen päivän `YYYY-MM` jokaisessa raportissa. "Tänään" ja oletusjakso seuraavat Europe/Helsinki -aikaa, joten hetki heti Helsingin keskiyön jälkeen on jo seuraava kuukausi, mutta aiemmin tallennettu kirjauspäivä ei siirry.
