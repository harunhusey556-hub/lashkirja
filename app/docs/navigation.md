# Navigointi

Yksi rekisteri: `app/src/lib/navigation.ts`. Välilehtipalkki ja sivupalkki piirtävät vain `placement: "tab"` -juuret. Asetukset on `placement: "avatar"` ja aukeaa profiilikuvasta.

Juuret: Koti, Myynti, Kirjanpito, Raportit. Mobiilissa Myynnin ja Kirjanpidon välissä on Lisää (+).

## Säännöt

1. Välilehtijuuria on tasan neljä, avatar-juuria yksi (Asetukset). Uusi ominaisuus ei saa uutta juurta.
2. Moduulissa on enintään yksi toinen navigointitaso; kolmitasoinen valikko on kielletty.
3. Detail-, luonti- ja muokkausnäkymät eivät ole päävalikossa.
4. Samalla toiminnolla ei ole kahta pysyvää valikkopolkua.
5. Juuren alapuolisella sivulla on yksi Takaisin: kuoren painike, jonka teksti on rekisterin vanhemman nimi. Ei murupolkuja, ei sivun omaa Takaisin-painiketta.
6. Suodattimet eivät vaihda sivua. Sivulla on enintään yksi suodatinrivi.
7. Luonti alkaa Lisää-valikosta. Myynnin "Uusi lasku" on saman reitin pikavalinta.
8. Uusi reitti vaatii `kind`-arvon rekisterissä; kaikki sivut ovat suojattuja, ellei niitä ole lueteltu `proxy.ts`:n `PUBLIC_PAGES`-listassa.

`navigationViolations()`, `navigation.test.ts` ja `proxy.test.ts` kaatavat testit, jos rekisteri tai suojaus rikkoo näitä.
