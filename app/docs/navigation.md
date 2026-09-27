# Navigointi

Yksi rekisteri: `app/src/lib/navigation.ts`. Sivupalkki ja mobiilin välilehdet piirtävät vain `kind === "root"`. Uusi ominaisuus ei saa uutta juurta.

Juuret: Etusivu, Pankki, Kuitit, Myynti, Kirjanpito, Raportit, Asetukset.
Mobiilin Muut: vain Kirjanpito, Raportit ja Asetukset.
Pankki on esimerkkityötila: Yhteenveto, Tapahtumat, Tilit, Täsmäytys.
Pankkiyhteyden tekninen asetus: Asetukset → Integraatiot → Pankkiyhteys. Tilillä oleva + Yhdistä on toiminto, ei toinen valikko.

## Kymmenen sääntöä

1. Työpöydän sivupalkissa on enintään 6–7 juurta.
2. Moduulissa on enintään yksi toinen navigointitaso.
3. Kolmitasoinen valikko on kielletty (juuri → työtila → työtila).
4. Detail-, luonti- ja muokkausnäkymät eivät ole päävalikossa.
5. Tekninen ja harvinainen asetus kuuluu Asetuksiin.
6. Päivittäinen työ hoituu enintään kahdella siirrolla.
7. Samalla toiminnolla ei ole kahta pysyvää valikkopolkua.
8. Detail-näkymässä on murupolku ja yksi Takaisin. Sovelluksen kuoren Takaisin ja sivun Takaisin eivät näy yhtä aikaa.
9. Uusi reitti vaatii `kind`-arvon (`root`, `workspace`, `detail` tai `settings`) rekisterissä.
10. Ominaisuutta ei työnnetä Muut-valikkoon. Muut sisältää vain jäljelle jäävät juuret.

`navigationViolations()` ja `navigation.test.ts` kaatavat buildin, jos rekisteri rikkoo näitä.
