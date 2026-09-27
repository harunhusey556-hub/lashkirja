# Pankin paluu sovellukseen

Yhdistäminen lähtee pankin sivulle tavallisella sivun vaihdolla. Sekä selain että nykyinen Capacitor-webview tarvitsevat sen, jotta pankki voi ohjata takaisin.

- Onnistunut paluu, peruutus (`access_denied`) ja vanhentunut istunto tulevat osoitteeseen `/bank/callback` ja näkyvät suomeksi. Virheestä pääsee takaisin asetuksiin painikkeella.
- Jos käyttäjä palaa asetuksiin ilman callbackia, sivu kertoo että yhdistäminen keskeytyi tai istunto vanheni.
- `@capacitor/app` kuuntelee `appUrlOpen`-osoitetta ja avaa callback-polun, jos käyttöjärjestelmä tuo sovelluksen takaisin sillä osoitteella.

Web käsittelee paluun sekä osoitteessa `https://…/bank/callback` että skeemassa `lashkirja://bank/callback`. `scripts/patch-ios-url-scheme.ts` lisää skeeman `Info.plist`-tiedostoon `cap sync` -ajon jälkeen (`scripts/build-ios-ipa.sh` kutsuu sitä). Jo asennettu IPA ei saa skeemaa ennen seuraavaa käännöstä. `capacitor.config.ts` osoittaa `errorPath`: `offline.html`, joten sama käännös näyttää offline-sivun, jos etäosoite ei aukea. `@capacitor/filesystem` ja `@capacitor/share` ovat riippuvuuksina, ja `cap sync` vie ne mukaan PDF-jakoon.
