# Laskunumerot

Jokaisella käyttäjällä on oma juokseva numeronsa. Seuraava numero tallennetaan tauluun `InvoiceSequence`.

- Luonnoksen poisto ei vapauta numeroa. Seuraava lasku saa suuremman numeron.
- Kaksi yhtäaikaista luontia ei saa samaa numeroa. Varaus ja laskun tallennus tapahtuvat samassa tietokantatapahtumassa, ja `(userId, number)` on yhä yksilöllinen.
- Vuodenvaihde ei nollaa sarjaa. Ensi vuoden ensimmäinen lasku jatkaa samasta juoksevasta numerosta.
- Aloitusnumeron voi siirtää vain eteenpäin (`PUT /api/invoices/sequence`). Pienempi pyyntö ei kelaa sarjaa taaksepäin eikä käytä jo annettua numeroa uudelleen.
