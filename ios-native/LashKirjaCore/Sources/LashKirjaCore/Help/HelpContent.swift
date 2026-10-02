import Foundation

/// The help page (/asetukset/ohje) and the questions people ask about the app,
/// in the app's own words.
public enum HelpContent {
    public struct Topic: Identifiable, Sendable {
        public let id: String
        public let title: String
        public let body: String
    }

    public struct Section: Identifiable, Sendable {
        public let id: String
        public let title: String
        public let topics: [Topic]
    }

    public static let intro = "Kuitit, laskut ja ALV löytyvät omista näkymistään. Jos jokin epäonnistuu, lähetä viesti: siihen tulee mukaan tukikoodi, jonka avulla vika löytyy."

    public static let sections: [Section] = [
        Section(id: "kirjanpito", title: "Kirjanpito", topics: [
            Topic(id: "kuitit", title: "Miten kuitti kirjataan?",
                  body: "Kuvaa kuitti +-painikkeella tai tuo se kuvista. Sovellus lukee summan, päivän ja ALV:n. Tarkista tiedot ja hyväksy kuitti, niin se on mukana kirjanpidossa ja ALV-laskelmassa."),
            Topic(id: "pankki", title: "Mitä pankkitapahtumille pitää tehdä?",
                  body: "Jokaiselle tulolle ja menolle tarvitaan tosite: kuitti, laskun maksu tai kuittaus. Pankki-näkymä näyttää tapahtumat, joilta puuttuu kuitti, ja ehdottaa sopivia kuitteja."),
            Topic(id: "kuukausi", title: "Miten kuukausi suljetaan?",
                  body: "Kaudet ja kuukauden sulku -näkymä listaa, mitä kuussa on kesken: kuitit, pankkitapahtumat, lähettämättömät laskut ja ALV. Kun kaikki on kunnossa, merkitse kuukausi valmiiksi. Suljetun kuukauden kuitteja, laskuja ja tapahtumia ei voi muuttaa."),
            Topic(id: "lukitus", title: "Voiko suljetun kauden avata?",
                  body: "Voi. Suljetut kaudet -kohdasta voit avata kaudet uudelleen, jos jokin ilmoitettu kausi pitää korjata. Avaaminen kysyy aina vahvistuksen."),
            Topic(id: "alv", title: "Mistä näen ALV:n?",
                  body: "ALV-ilmoitus-näkymä laskee OmaVeroon ilmoitettavat luvut kaudelle. Ilmoita ja maksa OmaVerossa ja merkitse ilmoitus sovellukseen annetuksi ja maksetuksi."),
            Topic(id: "kirjanpitaja", title: "Miten saan aineiston kirjanpitäjälle?",
                  body: "Raportit-välilehdeltä saat kuukauden aineiston zip-pakettina sekä CSV-tiedostot kuiteista, laskuista ja pankkitapahtumista."),
        ]),
        Section(id: "tili", title: "Tili ja turvallisuus", topics: [
            Topic(id: "salasana", title: "Unohdin salasanan",
                  body: "Valitse kirjautumisessa Unohtuiko salasana? ja kirjoita sähköpostiosoitteesi. Saat linkin, jolla valitset uuden salasanan 30 minuutin kuluessa. Voit avata linkin tai liittää sen sovellukseen."),
            Topic(id: "sahkoposti", title: "Miten vaihdan sähköpostin?",
                  body: "Asetuksissa Vaihda sähköposti lähettää vahvistuslinkin uuteen osoitteeseen. Nykyinen osoite toimii, kunnes linkki avataan."),
            Topic(id: "paasyavain", title: "Mikä on pääsyavain?",
                  body: "Pääsyavaimella kirjaudut Face ID:llä tai Touch ID:llä ilman salasanaa. Salasana toimii edelleen varalla. Pääsyavaimia voi nimetä ja poistaa asetuksista."),
            Topic(id: "tietosuoja", title: "Mitä tietoja LashKirja säilyttää?",
                  body: "Tilillä ovat nimesi, sähköpostisi ja salasanan tiiviste, yrityksen laskutustiedot, kuitit ja niiden tiedostot, tiliotteet, pankkitilit, asiakkaat, laskut, maksut, yhdistetyn postilaatikon tiedot ja keskustelut avustajan kanssa. Tietosuoja-näkymästä voit pyytää kopion tiedoista tai tilin sulkemista."),
        ]),
        Section(id: "avustaja", title: "Avustaja", topics: [
            Topic(id: "avustaja", title: "Mitä avustaja osaa?",
                  body: "Avustaja vastaa tilisi tietojen ja kirjanpidon perusteella ja avaa seuraavan vaiheen suoraan vastauksen painikkeesta. Jos tekoälypalvelu ei ole käytössä, avustaja opastaa sovelluksessa, auttaa kuittien kohdistamisessa ja kertoo kuukauden ALV:n."),
            Topic(id: "avustaja-tiedot", title: "Mitä avustajalle lähetetään?",
                  body: "Kun kysyt avustajalta jotain, kysymys ja saman keskustelun aiemmat viestit lähetetään tekoälypalveluun vastauksen muodostamista varten. Pankkiyhteyden salaisuuksia ei lähetetä."),
        ]),
    ]

    /// "LK-<build>-<time>", the web's support code shape (`errorReference`).
    public static func reference(build: String, now: Date = Date()) -> String {
        let cleaned = String(build.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII }.map(Character.init))
        let short = cleaned.isEmpty ? "unknown" : String(cleaned.prefix(7))
        let millis = Int64((now.timeIntervalSince1970 * 1000).rounded())
        return "LK-\(short)-\(String(millis, radix: 36))"
    }

    /// The message the report button shares (Mail, Messages, …).
    public static func reportText(reference: String, screen: String = "Ohje ja tuki") -> String {
        "LashKirja-ongelma\nViite: \(reference)\nSivu: \(screen)\n\nKerro tähän, mitä yritit tehdä:\n"
    }

    public static func supportLine(_ address: String?) -> String {
        if let address, !address.isEmpty { return "Voit myös kirjoittaa suoraan osoitteeseen \(address)." }
        return "Tukiosoitetta ei ole vielä määritetty tähän versioon. Ilmoita ongelmasta -painike avaa jaon, jolla voit lähettää viestin sille, joka sovelluksen sinulle antoi."
    }
}
