/// Koti's wording, shared by the view and its tests.
public enum Koti {
    public static func headline(blocking: Int) -> String {
        switch blocking {
        case ..<1: "Kaikki kunnossa"
        case 1: "1 asia ennen kuun loppua"
        default: "\(blocking) asiaa ennen kuun loppua"
        }
    }
}
