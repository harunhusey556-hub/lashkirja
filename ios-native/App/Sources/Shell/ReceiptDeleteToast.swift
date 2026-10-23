import SwiftUI
import LashKirjaCore

/// "Kuitti poistettu" with Kumoa, over a tab's screens for as long as the delete can be taken back
/// (`AppModel.deleteWithUndo`). It belongs to the app, not to Kuitit: the receipt's own screen closes
/// at the delete, and the owner may leave Kuitit before the toast ends.
struct ReceiptDeleteToast: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        // The animation sits on this stack, not on the screen: only the toast eases.
        ZStack {
            if let batch = app.receiptDelete.waiting {
                ToastView(toast: Toast(text: ReceiptDeleteText.toast(batch.ids.count), actionLabel: "Kumoa")) {
                    app.undoReceiptDelete()
                }
                .padding(.bottom, 8)
            }
        }
        .motion(.snappy, value: app.receiptDelete.waiting?.token)
    }
}
