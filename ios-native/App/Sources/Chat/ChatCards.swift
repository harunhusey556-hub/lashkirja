import SwiftUI
import LashKirjaCore

/// The widest a card under a reply grows: it reads as part of the conversation, not a full-width list.
private let cardMaxWidth: CGFloat = 360

/// "Ehdotus kohdistukseksi": the receipt and the bank row the assistant would link, with
/// Hyväksy / Hylkää, or what was decided.
struct ChatProposalCardView: View {
    let proposal: ChatMatchProposal
    let saving: ChatProposalDecision?
    let error: String?
    let decide: (ChatProposalDecision) -> Void

    var body: some View {
        let phase = ChatProposalCard.phase(proposal, saving: saving)
        VStack(alignment: .leading, spacing: 10) {
            Label(ChatProposalCard.title, systemImage: "link")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.accentDark)
            VStack(alignment: .leading, spacing: 4) {
                side("Kuitti", proposal.receiptSummary, symbol: "receipt")
                Image(systemName: "arrow.up.arrow.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.ink2)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                side("Pankkitapahtuma", proposal.txSummary, symbol: "building.columns")
            }
            if let reasons = reasonsLine { Text(reasons).font(.caption).foregroundStyle(Theme.ink2) }
            switch phase {
            case .open:
                HStack(spacing: 8) {
                    Button { decide(.accepted) } label: { Text("Hyväksy").fontWeight(.semibold).frame(maxWidth: .infinity) }
                        .buttonStyle(.primary)
                    Button { decide(.rejected) } label: {
                        Text("Hylkää")
                            .fontWeight(.semibold)
                            .foregroundStyle(Theme.ink)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(Theme.surface, in: Capsule())
                            .overlay(Capsule().stroke(Theme.line))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            case .saving, .accepted, .rejected:
                decided(phase)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
            }
        }
        .padding(14)
        .frame(maxWidth: cardMaxWidth, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(Theme.line))
        .animation(.snappy, value: phase)
    }

    private var reasonsLine: String? {
        let parts = proposal.reasons.filter { !$0.isEmpty } + [ChatProposalCard.confidenceLabel(proposal.confidenceScore)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func side(_ title: String, _ summary: String, symbol: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(Theme.accent).frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.caption).foregroundStyle(Theme.ink2)
                Text(ChatProposalCard.summary(summary)).font(.subheadline).foregroundStyle(Theme.ink)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func decided(_ phase: ChatProposalCard.Phase) -> some View {
        let accepted = phase == .accepted || phase == .saving(.accepted)
        return HStack(spacing: 6) {
            if saving != nil {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: accepted ? "checkmark.circle.fill" : "xmark.circle")
            }
            Text(ChatProposalCard.statusLabel(phase) ?? "")
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(accepted ? Theme.success : Theme.ink2)
    }
}

/// A reply's sources as tappable cards, one per screen; general bank links share one live bank card.
struct ChatDestinationCards: View {
    let cards: [ChatDestination]
    let model: ChatModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(cards) { card in
                if card.isBank {
                    NavigationLink(value: Route.bankHub) { ChatBankCard(card: card, model: model) }
                        .buttonStyle(.plain)
                } else if let route = Route.fromHref(card.href) {
                    NavigationLink(value: route) { ChatDestinationCard(card: card) }
                        .buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: cardMaxWidth, alignment: .leading)
    }
}

private struct ChatDestinationCard: View {
    let card: ChatDestination

    var body: some View {
        HStack(spacing: 12) {
            ChatCardIcon(symbol: card.symbol, accent: card.isAction)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(card.isAction ? Theme.accentDark : Theme.ink)
                    .lineLimit(1)
                Text(card.detail).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2)
        }
        .chatCardBackground(accent: card.isAction)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isLink)
    }
}

/// Pankki with the live total and number of accounts, read the way the Pankki hub reads them.
private struct ChatBankCard: View {
    @Environment(AppModel.self) private var app
    let card: ChatDestination
    let model: ChatModel

    var body: some View {
        HStack(spacing: 12) {
            ChatCardIcon(symbol: "building.columns", accent: card.isAction)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                if let bank = model.bank {
                    MoneyText(amount: bank.total).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text(bank.accountsLabel).font(.caption).foregroundStyle(Theme.ink2)
                    if let notice = bank.notice {
                        Text(notice).font(.caption).foregroundStyle(Theme.warning).lineLimit(2)
                    }
                } else if model.bankFailed {
                    Text(card.detail).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
                } else {
                    Text("Haetaan saldoa…").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2)
        }
        .chatCardBackground(accent: card.isAction)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isLink)
        // A write elsewhere (a receipt matched, a statement imported) bumps the version: read again.
        .task(id: app.dataVersion) { await model.loadBank() }
    }
}

private struct ChatCardIcon: View {
    let symbol: String
    let accent: Bool

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(accent ? Theme.onInk : Theme.accentDark)
            .frame(width: 36, height: 36)
            .background(accent ? Theme.accentFill : Theme.accentSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityHidden(true)
    }
}

private extension View {
    func chatCardBackground(accent: Bool) -> some View {
        padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(accent ? Theme.accentSoft : Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(accent ? Theme.accent.opacity(0.35) : Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
    }
}

/// The owner's receipt inside their bubble: thumbnail (or a document icon) above the name.
struct ChatAttachmentPreview: View {
    let attachment: ChatAttachment

    var body: some View {
        Group {
            if let thumbnail = attachment.thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 160, height: 120)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                Image(systemName: attachment.isPDF ? "doc.richtext" : "photo")
                    .font(.system(size: 28))
                    .frame(width: 160, height: 80)
                    .background(Theme.onInk.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .overlay {
            if attachment.phase.isBusy {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.black.opacity(0.25))
                ProgressView().tint(.white)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Under a receipt bubble: how far the upload is, or why it failed with a way to try again.
struct ChatAttachmentStatus: View {
    let phase: ChatReceiptPhase
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if case .sending(let fraction) = phase {
                ProgressView(value: min(max(fraction, 0), 1)).frame(width: 160).tint(Theme.accent)
            }
            if let label = phase.label {
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(phase.canRetry ? Theme.danger : Theme.ink2)
                    .multilineTextAlignment(.trailing)
            }
            if phase.canRetry {
                HStack(spacing: 14) {
                    Button("Poista", role: .destructive, action: discard).font(.footnote)
                    Button("Yritä uudelleen", action: retry).font(.footnote.weight(.semibold))
                }
            }
        }
    }
}
