# P0.2 part 2 — every tap answers at once (2026-10-05)

Branch `feature/tap-feedback` from `origin/native`.

## Finding

SwiftUI `.buttonStyle(.plain)` removes the system press highlight, and the app used it on 46 card/row
buttons (Koti cards, bank/receipt/invoice rows, AI chat cards, onboarding choices). The finger got no
visible answer there. System buttons in `List`, the shared `.primary` / `OutlineButtonStyle`
(both use `configuration.isPressed`), `.borderless` row buttons and toolbar buttons already answer.

## Audit

| Category | Before | After | Files |
|---|---|---|---|
| Primary button (`.primary`) | pressed = opacity 0.8, ok | unchanged | `Theme.swift` |
| Secondary button (`OutlineButtonStyle`) | pressed = surface 0.6, ok | unchanged | `Login/AuthFormParts.swift` |
| Navigation rows / tappable cards (Koti, Myynti, Kirjanpito, chat cards, onboarding): 46 `Button`s with `.plain` | **no pressed state** | `.pressable`: opacity 0.6 at touch-down, scale 0.98 (opacity only when Reduce Motion is on) | new `PressableButtonStyle` in `Components/Components.swift`; 18 view files |
| Invoice / receipt / bank rows | same `.plain` gap, mostly | fixed by the same style | `BankFeedView`, `ReceiptsView`, `MyyntiView`, `PurchaseInvoicesView`, ... |
| AI action cards | `.plain` gap | fixed | `Chat/ChatCards.swift`, `AssistantView.swift` |
| `onTapGesture` | 3 sites: two chart overlays (Koti cash flow, Raportit) and the OTP code field. Not cards: a chart has no pressed state to show, the code field answers with focus. Raportit chart already had selection haptic; Koti did not | Koti chart: `Haptics.selection()` added. Others left as is | `Koti/KotiView.swift` |
| Toolbar actions, sheet actions | system buttons, pressed state ok; busy shown by disabled only | customer sheet "Tallenna" now shows the in-flight spinner | `Myynti/CustomersView.swift` |
| Segmented controls / pickers (11) | system controls, answer natively | unchanged | - |
| Destructive actions (73 `role: .destructive`) | system dialogs/swipe actions, pressed state native; success/error haptics already present in the mutation paths | unchanged | - |
| Haptics on completion | `Haptics.success/error` already used on ~50 screens; customer save lacked the error haptic | error haptic added; no haptics on plain navigation (unchanged) | `CustomersView.swift` |
| Customer create guard (left over from part 1) | `busy` set inside the async function, key never reset: second tap could resend, key reused after success | `SubmitGuard` as in the other views: `begin()` before the first await, one key until success, `finish(succeeded:)` | `Myynti/CustomersView.swift` |

Counts: 8 categories audited, 4 had gaps (plain-style cards/rows, AI cards, customer guard,
Koti chart haptic), all fixed. No pure logic added, so no new core tests (UI verified by CI build).

## Turkish device checklist

1. Koti'de bir kartı (ör. nakit akışı, onay kartı) parmağı basılı tutarak dene: kart hemen soluklaşıp hafifçe küçülmeli.
2. Ayarlar > Erişilebilirlik > Hareketi Azalt açıkken aynı kartlar yalnız soluklaşmalı, küçülmemeli.
3. Satış, Kirjanpito (kuitti, banka satırı, ostolasku) listelerinde bir satıra basılı tut: anında görsel tepki olmalı.
4. AI asistanında bir eylem/öneri kartına bas: soluklaşma görünmeli, kart yine açılmalı.
5. Yeni müşteri oluştur: "Tallenna"ya hızlıca iki kez bas; tek müşteri oluşmalı, buton yerinde spinner göstermeli. Hata olunca (ör. uçak modu) hata titreşimi gelmeli.
6. Koti nakit akışı grafiğinde bir aya dokun: hafif seçim titreşimi ve ay değişmeli.
