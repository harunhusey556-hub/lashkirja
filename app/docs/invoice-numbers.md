# Laskunumerot

Jokaisella käyttäjällä on oma juokseva numeronsa. Seuraava numero tallennetaan tauluun `InvoiceSequence`.

- Sarja pysyy katkeamattomana: uusimman, lähettämättömän luonnoksen poisto vapauttaa sen numeron seuraavalle laskulle. Luonnos, joka on koskaan lähetetty tai merkitty lähetetyksi, ei vapauta numeroaan. Keskeltä sarjaa poistetun luonnoksen numero ei vapaudu, koska myöhemmät numerot ovat jo käytössä.
- Kaksi yhtäaikaista luontia ei saa samaa numeroa. Varaus ja laskun tallennus tapahtuvat samassa tietokantatapahtumassa, ja `(userId, number)` on yhä yksilöllinen.
- Vuodenvaihde ei nollaa sarjaa. Ensi vuoden ensimmäinen lasku jatkaa samasta juoksevasta numerosta.
- Aloitusnumeron voi siirtää vain eteenpäin (`PUT /api/invoices/sequence`). Pienempi pyyntö ei kelaa sarjaa taaksepäin eikä käytä jo annettua numeroa uudelleen.
