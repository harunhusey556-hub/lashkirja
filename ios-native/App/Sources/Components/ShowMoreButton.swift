import SwiftUI
import LashKirjaCore

/// The "Näytä enemmän (N)" row under a list that `ShowMore` limits. Shows nothing for a short list.
struct ShowMoreButton: View {
    @Binding var limit: ShowMore
    let total: Int

    var body: some View {
        if let title = limit.buttonTitle(total: total) {
            Button {
                withAnimation(.snappy) { limit.more(total: total) }
                Haptics.selection()
            } label: {
                HStack {
                    Text(title).font(.subheadline.weight(.semibold))
                    Spacer()
                    Image(systemName: limit.visible(total) >= total ? "chevron.up" : "chevron.down").font(.caption.weight(.semibold))
                }
                .foregroundStyle(Theme.accent)
            }
        }
    }
}
