import SwiftUI

enum AppTab: Hashable, CaseIterable {
    case koti, myynti, kirjanpito, raportit, add

    var title: String {
        switch self {
        case .koti: "Koti"
        case .myynti: "Myynti"
        case .kirjanpito: "Kirjanpito"
        case .raportit: "Raportit"
        case .add: "Lisää"
        }
    }

    var symbol: String {
        switch self {
        case .koti: "house"
        case .myynti: "doc.text"
        case .kirjanpito: "book"
        case .raportit: "chart.bar"
        case .add: "plus"
        }
    }
}

/// Every pushed screen.
enum Route: Hashable {
    case placeholder(String)
    case invoice(String)
    case customers
    case customer(String)
}

extension View {
    func appDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .placeholder(let title): PlaceholderScreen(title: title)
            case .invoice(let id): InvoiceDetailView(invoiceId: id)
            case .customers: CustomersView()
            case .customer(let id): CustomerDetailView(customerId: id)
            }
        }
    }
}
