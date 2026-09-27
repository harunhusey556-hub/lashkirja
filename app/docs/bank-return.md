# Pankin paluu sovellukseen

Yhdistäminen lähtee pankin sivulle tavallisella sivun vaihdolla. Sekä selain että nykyinen Capacitor-webview tarvitsevat sen, jotta pankki voi ohjata takaisin.

- Onnistunut paluu, peruutus (`access_denied`) ja vanhentunut istunto tulevat osoitteeseen `/bank/callback` ja näkyvät suomeksi. Virheestä pääsee takaisin asetuksiin painikkeella.
- Jos käyttäjä palaa asetuksiin ilman callbackia, sivu kertoo että yhdistäminen keskeytyi tai istunto vanheni.
- `@capacitor/app` kuuntelee `appUrlOpen`-osoitetta ja avaa callback-polun, jos käyttöjärjestelmä tuo sovelluksen takaisin sillä osoitteella.

Nykyisessä IPA:ssa ei ole omaa URL-skeemaa. Pankin ohjaus toimii webview’n sisällä, kun paluuosoite on sovelluksen oma osoite. Erillinen deep link suljettuun sovellukseen vaatii uuden IPA:n.
