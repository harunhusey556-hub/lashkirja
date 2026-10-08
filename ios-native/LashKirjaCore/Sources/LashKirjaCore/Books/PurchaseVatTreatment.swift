import Foundation

/// How a purchase's VAT reaches the return (server `lib/alv.ts`): domestic VAT on the document,
/// or a reverse charge self-assessed and deducted alike, or Finnish VAT a foreign seller charged
/// (not deductible). The words are the web forms' (`lib/foreign-purchase.ts`).
public enum PurchaseVatTreatment: String, CaseIterable, Codable, Sendable, Identifiable {
    case domestic
    case euService = "eu_service"
    case euGoods = "eu_goods"
    case nonEuService = "non_eu_service"
    case nonEuGoods = "non_eu_goods"
    case foreignVatCharged = "foreign_vat_charged"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .domestic: "Kotimainen ALV"
        case .euService: "Palveluosto EU-maasta (käännetty verovelvollisuus)"
        case .euGoods: "Tavaraosto EU-maasta (käännetty verovelvollisuus)"
        case .nonEuService: "Palveluosto EU:n ulkopuolelta (käännetty verovelvollisuus)"
        case .nonEuGoods: "Tavaroiden maahantuonti EU:n ulkopuolelta"
        case .foreignVatCharged: "Ulkomainen myyjä veloitti Suomen ALV:n (ei vähennettävissä)"
        }
    }

    /// One line under the choice: what it does to the VAT return. Empty for domestic.
    public var hint: String {
        switch self {
        case .domestic: ""
        case .euService: "Laskussa ei ole ALV:ta. Vero lasketaan kohtaan 306 ja vähennetään samalla summalla kohdassa 307, joten maksettavaa ei jää."
        case .euGoods: "Laskussa ei ole ALV:ta. Vero lasketaan kohtaan 305 ja vähennetään samalla summalla kohdassa 307, joten maksettavaa ei jää."
        case .nonEuService: "Laskussa ei ole ALV:ta. Vero lasketaan kohtaan 301 ja vähennetään samalla summalla kohdassa 307, joten maksettavaa ei jää."
        case .nonEuGoods: "Tuonnin ALV maksetaan Tullille tai ilmoitetaan erikseen. Sovellus ei laske sitä, vaan kuitti näkyy ALV-ilmoituksen tarkistettavissa."
        case .foreignVatCharged: "Myyjä veloitti Suomen ALV:n, jota ei voi vähentää. Anna myyjälle ALV-tunnuksesi, niin seuraavat laskut tulevat ilman veroa."
        }
    }
}
