# Motion audit

94 steps. FAIL: intermediate 3, flash 0, shift (video) 10, shift (probe) 8; crashes 0.

## Calibration

Thresholds were set on test00_Calibration: good = tab switch to Kirjanpito, push to
Kuukauden sulku and its swipe-back; bad = the w32 brief's item 7 (capture upload, the screen moves
when the reading finishes) and item 9 ("Näytä tarkistettavat": cover closes, tab switches, Kuitit
pushed). See the calibration table below for what each check said about them.

Thresholds: STATIC_DIFF=1.2, DISTINCT=9.0, HOLD_S=0.25 (drag steps 0.8, quiet 1.2000000000000002), FLASH_LUMA=40.0, QUIET_S=0.6, SHIFT_AREA=0.015, PROBE_MIN_PT=3.

Jank is not judged: the simulator writes ~4 frames a second, so 'dropped' counts every animation.

## Steps

| suite | step | from → to | kind | reached | intermediate | flash | shift video | shift probe | settle ms | dropped@60 | sheet |
|---|---|---|---|---|---|---|---|---|---|---|---|
| calibration | good-tab-kirjanpito | Koti → tab Kirjanpito | nav | NO | PASS | PASS | PASS | PASS | 3335 | 4 | [png](all/sheet-good-tab-kirjanpito.png) |
| calibration | bad-link-over-sheet | Asetukset sheet on Koti → Lasku (Myynti) | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-bad-link-over-sheet.png) |
| koti | koti-from-myynti-setup | launch → tab Koti | nav | yes | PASS | PASS | PASS | PASS | 1929 | 11 | [png](all/sheet-koti-from-myynti-setup.png) |
| koti | koti-refresh | Koti → Koti | load | yes | n/a | PASS | PASS | FAIL | 3869 | 82 | [png](all/sheet-koti-refresh.png) |
| koti | koti-prev-month | Koti → Koti (previous month) | swap | yes | PASS | PASS | PASS | FAIL | 4089 | 0 | [png](all/sheet-koti-prev-month.png) |
| koti | koti-next-month | Koti (previous month) → Koti | swap | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-koti-next-month.png) |
| koti | koti-scroll | Koti → Koti | scroll | yes | PASS | PASS | n/a | PASS | 3707 | 64 | [png](all/sheet-koti-scroll.png) |
| koti | koti-settings-sheet | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 3707 | 20 | [png](all/sheet-koti-settings-sheet.png) |
| koti | koti-settings-close | Asetukset sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3053 | 5 | [png](all/sheet-koti-settings-close.png) |
| koti | koti-assistant-sheet | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 3924 | 19 | [png](all/sheet-koti-assistant-sheet.png) |
| koti | koti-assistant-swipedown | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 2948 | 77 | [png](all/sheet-koti-assistant-swipedown.png) |
| koti | koti-add-sheet | Koti → Lisää sheet | sheet | yes | PASS | PASS | FAIL | PASS | 1148 | 4 | [png](all/sheet-koti-add-sheet.png) |
| koti | koti-add-close | Lisää sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 1340 | 5 | [png](all/sheet-koti-add-close.png) |
| myynti | myynti-tab | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 3099 | 15 | [png](all/sheet-myynti-tab.png) |
| myynti | myynti-tab-revisit-koti | Myynti → tab Koti | nav | yes | PASS | PASS | FAIL | PASS | 658 | 0 | [png](all/sheet-myynti-tab-revisit-koti.png) |
| myynti | myynti-tab-revisit | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 1347 | 5 | [png](all/sheet-myynti-tab-revisit.png) |
| myynti | myynti-refresh | Myynti → Myynti | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-refresh.png) |
| myynti | myynti-customers-open | Myynti → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 2784 | 5 | [png](all/sheet-myynti-customers-open.png) |
| myynti | myynti-customer-open | Asiakkaat → Asiakas | nav | yes | PASS | PASS | PASS | PASS | 1947 | 17 | [png](all/sheet-myynti-customer-open.png) |
| myynti | myynti-customer-back | Asiakas → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 1659 | 14 | [png](all/sheet-myynti-customer-back.png) |
| myynti | myynti-customers-swipeback | Asiakkaat → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1696 | 41 | [png](all/sheet-myynti-customers-swipeback.png) |
| myynti | myynti-recurring-open | Myynti → Toistuvat laskut | nav | yes | PASS | PASS | PASS | PASS | 2246 | 21 | [png](all/sheet-myynti-recurring-open.png) |
| myynti | myynti-recurring-swipeback | Toistuvat laskut → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1546 | 27 | [png](all/sheet-myynti-recurring-swipeback.png) |
| myynti | myynti-filter-late | Myynti → Laskut (myöhässä) | swap | yes | FAIL | PASS | FAIL | FAIL | 2800 | 41 | [png](all/sheet-myynti-filter-late.png) |
| myynti | myynti-invoice-open | Myynti → Lasku | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-invoice-open.png) |
| myynti | myynti-invoice-scroll | Lasku → Lasku | scroll | yes | PASS | PASS | n/a | PASS | 1298 | 34 | [png](all/sheet-myynti-invoice-scroll.png) |
| myynti | myynti-invoice-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 2044 | 11 | [png](all/sheet-myynti-invoice-back.png) |
| myynti | myynti-new-invoice | Myynti → Uusi lasku | sheet | yes | PASS | PASS | FAIL | PASS | 3187 | 32 | [png](all/sheet-myynti-new-invoice.png) |
| myynti | myynti-new-invoice-cancel | Uusi lasku → Myynti | sheet | yes | PASS | PASS | PASS | PASS | 3392 | 6 | [png](all/sheet-myynti-new-invoice-cancel.png) |
| myynti | myynti-list-scroll | Myynti → Myynti | scroll | yes | PASS | PASS | n/a | PASS | 1559 | 33 | [png](all/sheet-myynti-list-scroll.png) |
| raportit | raportit-tab | Koti → tab Raportit | nav | yes | PASS | PASS | PASS | PASS | 3577 | 21 | [png](all/sheet-raportit-tab.png) |
| raportit | raportit-prev-year | Raportit → Raportit (previous year) | swap | yes | PASS | PASS | FAIL | FAIL | 3834 | 0 | [png](all/sheet-raportit-prev-year.png) |
| raportit | raportit-next-year | Raportit (previous year) → Raportit | swap | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-raportit-next-year.png) |
| raportit | raportit-refresh | Raportit → Raportit | load | yes | n/a | PASS | PASS | PASS | 2605 | 93 | [png](all/sheet-raportit-refresh.png) |
| raportit | raportit-drill-open | Raportit → drill-down | nav | yes | PASS | PASS | FAIL | PASS | 1158 | 0 | [png](all/sheet-raportit-drill-open.png) |
| raportit | raportit-drill-swipeback | drill-down → Raportit | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-raportit-drill-swipeback.png) |
| raportit | raportit-scroll | Raportit → Raportit | scroll | yes | FAIL | PASS | n/a | PASS | 1589 | 50 | [png](all/sheet-raportit-scroll.png) |
| asetukset | asetukset-open | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 4076 | 38 | [png](all/sheet-asetukset-open.png) |
| asetukset | asetukset-seller-open | Asetukset → Laskuttajan tiedot | nav | yes | PASS | PASS | PASS | PASS | 3371 | 18 | [png](all/sheet-asetukset-seller-open.png) |
| asetukset | asetukset-seller-back | Laskuttajan tiedot → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2012 | 12 | [png](all/sheet-asetukset-seller-back.png) |
| asetukset | asetukset-templates-open | Asetukset → Sähköpostimallit | nav | yes | PASS | PASS | PASS | PASS | 2400 | 17 | [png](all/sheet-asetukset-templates-open.png) |
| asetukset | asetukset-templates-back | Sähköpostimallit → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1717 | 12 | [png](all/sheet-asetukset-templates-back.png) |
| asetukset | asetukset-payments-open | Asetukset → Maksut | nav | yes | PASS | PASS | PASS | PASS | 2345 | 35 | [png](all/sheet-asetukset-payments-open.png) |
| asetukset | asetukset-payments-back | Maksut → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1531 | 17 | [png](all/sheet-asetukset-payments-back.png) |
| asetukset | asetukset-password-open | Asetukset → Vaihda salasana | nav | yes | PASS | PASS | FAIL | PASS | 2796 | 3 | [png](all/sheet-asetukset-password-open.png) |
| asetukset | asetukset-password-back | Vaihda salasana → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1846 | 9 | [png](all/sheet-asetukset-password-back.png) |
| asetukset | asetukset-passkeys-open | Asetukset → Pääsyavaimet | nav | yes | PASS | PASS | PASS | PASS | 3502 | 18 | [png](all/sheet-asetukset-passkeys-open.png) |
| asetukset | asetukset-passkeys-back | Pääsyavaimet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1521 | 0 | [png](all/sheet-asetukset-passkeys-back.png) |
| asetukset | asetukset-devices-open | Asetukset → Laitteet | nav | yes | PASS | PASS | PASS | PASS | 3831 | 15 | [png](all/sheet-asetukset-devices-open.png) |
| asetukset | asetukset-devices-back | Laitteet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1934 | 24 | [png](all/sheet-asetukset-devices-back.png) |
| asetukset | asetukset-lock-open | Asetukset → Sovelluslukitus | nav | yes | PASS | PASS | PASS | PASS | 3035 | 13 | [png](all/sheet-asetukset-lock-open.png) |
| asetukset | asetukset-lock-back | Sovelluslukitus → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1759 | 10 | [png](all/sheet-asetukset-lock-back.png) |
| asetukset | asetukset-notifications-open | Asetukset → Ilmoitukset | nav | yes | PASS | PASS | PASS | PASS | 3247 | 10 | [png](all/sheet-asetukset-notifications-open.png) |
| asetukset | asetukset-notifications-back | Ilmoitukset → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2094 | 23 | [png](all/sheet-asetukset-notifications-back.png) |
| asetukset | asetukset-privacy-open | Asetukset → Tietosuoja | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-privacy-open.png) |
| asetukset | asetukset-privacy-back | Tietosuoja → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2453 | 0 | [png](all/sheet-asetukset-privacy-back.png) |
| asetukset | asetukset-close | Asetukset sheet → Koti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-close.png) |
| chat | chat-open | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 4156 | 24 | [png](all/sheet-chat-open.png) |
| chat | chat-focus | Avustaja → Avustaja (keyboard) | swap | yes | PASS | PASS | PASS | PASS | 2843 | 22 | [png](all/sheet-chat-focus.png) |
| chat | chat-send | Avustaja → Avustaja (answer) | load | yes | n/a | PASS | FAIL | PASS | 4268 | 0 | [png](all/sheet-chat-send.png) |
| chat | chat-close | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3379 | 131 | [png](all/sheet-chat-close.png) |
| lasku | lasku-new | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | FAIL | 3768 | 31 | [png](all/sheet-lasku-new.png) |
| lasku | lasku-customer-picker | Uusi lasku → asiakasvalinta | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-customer-picker.png) |
| lasku | lasku-customer-cancel | asiakasvalinta → Uusi lasku | nav | yes | PASS | PASS | PASS | PASS | 2138 | 18 | [png](all/sheet-lasku-customer-cancel.png) |
| lasku | lasku-form-scroll | Uusi lasku → Uusi lasku | scroll | yes | PASS | PASS | n/a | PASS | 1574 | 36 | [png](all/sheet-lasku-form-scroll.png) |
| lasku | lasku-cancel | Uusi lasku → Myynti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-cancel.png) |
| lasku | lasku-open | Myynti → Lasku | nav | yes | FAIL | PASS | FAIL | FAIL | 2931 | 5 | [png](all/sheet-lasku-open.png) |
| lasku | lasku-copy | Lasku → Uusi lasku (copy) | sheet | yes | PASS | PASS | PASS | PASS | 2289 | 7 | [png](all/sheet-lasku-copy.png) |
| lasku | lasku-copy-cancel | Uusi lasku (copy) → Lasku | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-copy-cancel.png) |
| lasku | lasku-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 2253 | 15 | [png](all/sheet-lasku-back.png) |
| pankki | pankki-kirjanpito-tab | Koti → tab Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2718 | 18 | [png](all/sheet-pankki-kirjanpito-tab.png) |
| pankki | pankki-hub-open | Kirjanpito → Pankki | nav | yes | PASS | PASS | PASS | PASS | 3564 | 31 | [png](all/sheet-pankki-hub-open.png) |
| pankki | pankki-feed-open | Pankki → Pankkitapahtumat | nav | yes | PASS | PASS | PASS | PASS | 2316 | 19 | [png](all/sheet-pankki-feed-open.png) |
| pankki | pankki-feed-scroll | Pankkitapahtumat → Pankkitapahtumat | scroll | yes | PASS | PASS | n/a | PASS | 1724 | 56 | [png](all/sheet-pankki-feed-scroll.png) |
| pankki | pankki-feed-more | Pankkitapahtumat → Pankkitapahtumat (more) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-pankki-feed-more.png) |
| pankki | pankki-feed-back | Pankkitapahtumat → Pankki | nav | yes | PASS | PASS | PASS | PASS | 2563 | 46 | [png](all/sheet-pankki-feed-back.png) |
| pankki | pankki-accounts-open | Pankki → Pankkiyhteys ja tilit | nav | yes | PASS | PASS | PASS | PASS | 3714 | 9 | [png](all/sheet-pankki-accounts-open.png) |
| pankki | pankki-accounts-back | Pankkiyhteys ja tilit → Pankki | nav | yes | PASS | PASS | PASS | PASS | 1834 | 15 | [png](all/sheet-pankki-accounts-back.png) |
| pankki | pankki-hub-back | Pankki → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2024 | 16 | [png](all/sheet-pankki-hub-back.png) |
| pankki | kirjanpito-email-open | Kirjanpito → Sähköposti | nav | yes | PASS | PASS | PASS | PASS | 2547 | 18 | [png](all/sheet-kirjanpito-email-open.png) |
| pankki | kirjanpito-email-back | Sähköposti → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1979 | 31 | [png](all/sheet-kirjanpito-email-back.png) |
| pankki | kirjanpito-purchases-open | Kirjanpito → Ostolaskut | nav | yes | PASS | PASS | PASS | FAIL | 4036 | 12 | [png](all/sheet-kirjanpito-purchases-open.png) |
| pankki | kirjanpito-purchases-back | Ostolaskut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1842 | 28 | [png](all/sheet-kirjanpito-purchases-back.png) |
| pankki | kirjanpito-match-open | Kirjanpito → Kohdista ostolaskujen maksut | nav | yes | PASS | PASS | FAIL | PASS | 2238 | 10 | [png](all/sheet-kirjanpito-match-open.png) |
| pankki | kirjanpito-match-back | Kohdista ostolaskujen maksut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1663 | 37 | [png](all/sheet-kirjanpito-match-back.png) |
| pankki | kirjanpito-periods-open | Kirjanpito → Kuukauden sulku | nav | yes | PASS | PASS | PASS | PASS | 2305 | 19 | [png](all/sheet-kirjanpito-periods-open.png) |
| pankki | kirjanpito-periods-back | Kuukauden sulku → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1532 | 29 | [png](all/sheet-kirjanpito-periods-back.png) |
| pankki | kirjanpito-alv-open | Kirjanpito → ALV-ilmoitus | nav | yes | PASS | PASS | PASS | PASS | 4097 | 48 | [png](all/sheet-kirjanpito-alv-open.png) |
| pankki | kirjanpito-alv-back | ALV-ilmoitus → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1716 | 39 | [png](all/sheet-kirjanpito-alv-back.png) |
| pankki | kirjanpito-ledger-open | Kirjanpito → Kirjanpito, Tuloslaskelma | nav | yes | PASS | PASS | PASS | PASS | 2758 | 19 | [png](all/sheet-kirjanpito-ledger-open.png) |
| pankki | kirjanpito-ledger-back | Kirjanpito, Tuloslaskelma → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1641 | 33 | [png](all/sheet-kirjanpito-ledger-back.png) |
| offline | offline-tab-myynti | Koti → tab Myynti (offline) | nav | yes | PASS | PASS | PASS | FAIL | 3072 | 14 | [png](all/sheet-offline-tab-myynti.png) |
| offline | offline-refresh | Myynti → Myynti (offline error) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-offline-refresh.png) |
| offline | online-again | Myynti (offline) → Myynti | load | yes | n/a | PASS | PASS | PASS | 3366 | 0 | [png](all/sheet-online-again.png) |

## Details of FAIL rows

- **koti/koti-refresh** (Koti → Koti): intermediate screens [{'frame': 7, 't': 2.67, 'held_s': 0.44, 'd_start': 12.9, 'd_end': 10.5}]; probe ['MOVE 1792072140.780 tab.koti n=1 max=60 NavigationBarLargeTitleView@0,116,402x52:0,-60', 'SCROLLJUMP 1792072140.812 tab.koti dy=4', 'MOVE 1792072140.813 tab.koti n=11 max=4 _UITouchPassthroughView@0,-224,402x874:0,4 BackdropView@0,-224,402x170:0,4 BackdropView@0,502,402x147:0,4']
- **koti/koti-prev-month** (Koti → Koti (previous month)): probe ['MOVE 1792072154.964 tab.koti n=27 max=218 _SwiftUILayerDelegate@20,668,93x15:0,-218 _SwiftUILayerDelegate@16,817,370x204:0,-218 _SwiftUILayerDelegate@30,831,140x18:0,-218', 'MOVE 1792072154.998 tab.koti n=33 max=8 _SwiftUILayerDelegate@19,520,36x36:-8,0 _SwiftUILayerDelegate@28,530,18x14:-8,0 _SwiftUILayerDelegate@67,519,52x20:-8,0', 'MOVE 1792072155.113 tab.koti n=33 max=170 _SwiftUILayerDelegate@-151,520,36x36:-170,0 _SwiftUILayerDelegate@-142,530,18x14:-170,0 _SwiftUILayerDelegate@-103,519,52x20:-170,0']
- **koti/koti-add-sheet** (Koti → Lisää sheet): late change [{'t': 2.2, 'area': 0.033, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.37, 'area': 0.08, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.41, 'area': 0.096, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.6, 'area': 0.025, 'dy_pt': -7, 'what': 'move'}, {'t': 2.61, 'area': 0.031, 'dy_pt': -6, 'what': 'move'}, {'t': 2.82, 'area': 0.03, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-tab-revisit-koti** (Myynti → tab Koti): late change [{'t': 1.31, 'area': 0.11, 'dy_pt': 0, 'what': 'pop'}, {'t': 1.39, 'area': 0.097, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-filter-late** (Myynti → Laskut (myöhässä)): intermediate screens [{'frame': 7, 't': 2.22, 'held_s': 0.58, 'd_start': 10.2, 'd_end': 18.8}]; late change [{'t': 4.03, 'area': 0.023, 'dy_pt': 0, 'what': 'pop'}]; probe ['MOVE 1792072436.156 invoice("87577a3e-9478-4de2-95f5-088b68694642") n=5 max=7 HostedViewWrapper@170,73,62x20:-7,0 _UINavigationBarTitleControl@170,73,62x20:-7,0 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@170,73,62x20:-7,0', 'MOVE 1792072437.091 invoice("87577a3e-9478-4de2-95f5-088b68694642") n=9 max=47 _SwiftUILayerDelegate@134,344,38x14:-47,0 _SwiftUILayerDelegate@144,321,18x18:-47,0 _SwiftUILayerDelegate@130,271,180x20:-42,0']
- **myynti/myynti-new-invoice** (Myynti → Uusi lasku): late change [{'t': 3.9, 'area': 0.053, 'dy_pt': 0, 'what': 'pop'}]
- **raportit/raportit-prev-year** (Raportit → Raportit (previous year)): late change [{'t': 4.54, 'area': 0.037, 'dy_pt': 0, 'what': 'pop'}]; probe ['MOVE 1792072593.100 tab.raportit n=19 max=319 ListCollectionViewCell@16,681,370x52:0,319 _UISystemBackgroundView@16,681,370x52:0,319 UIView@16,681,370x52:0,319']
- **raportit/raportit-drill-open** (Raportit → drill-down): late change [{'t': 2.6, 'area': 0.047, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.61, 'area': 0.029, 'dy_pt': 0, 'what': 'pop'}, {'t': 3.05, 'area': 0.054, 'dy_pt': 0, 'what': 'pop'}]
- **raportit/raportit-scroll** (Raportit → Raportit): intermediate screens [{'frame': 1, 't': 0.64, 'held_s': 0.3, 'd_start': 14.0, 'd_end': 13.3}]
- **asetukset/asetukset-password-open** (Asetukset → Vaihda salasana): late change [{'t': 3.46, 'area': 0.029, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-send** (Avustaja → Avustaja (answer)): intermediate screens [{'frame': 113, 't': 4.27, 'held_s': 1.69, 'd_start': 9.2, 'd_end': 12.0}]; late change [{'t': 6.0, 'area': 0.083, 'dy_pt': 0, 'what': 'pop'}]
- **lasku/lasku-new** (Myynti → Uusi lasku): probe ['MOVE 1792073119.926 tab.myynti n=3 max=25 HostedViewWrapper@135,83,132x34:-25,-6 _UINavigationBarTitleControl@135,83,132x34:-25,-6 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@135,83,132x34:-25,-6']
- **lasku/lasku-open** (Myynti → Lasku): intermediate screens [{'frame': 7, 't': 2.93, 'held_s': 0.89, 'd_start': 10.0, 'd_end': 17.8}]; late change [{'t': 3.82, 'area': 0.086, 'dy_pt': 0, 'what': 'pop'}]; probe ['MOVE 1792073191.297 invoice("cb36d2a9-5db6-4302-936b-8be6ec2e70fb") n=5 max=7 HostedViewWrapper@169,73,62x20:-7,0 _UINavigationBarTitleControl@169,73,62x20:-7,0 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@169,73,62x20:-7,0']
- **pankki/kirjanpito-purchases-open** (Kirjanpito → Ostolaskut): probe ['MOVE 1792073416.789 purchaseInvoices n=13 max=85 HostedViewWrapper@72,73,86x20:-85,0 _UINavigationBarTitleControl@72,73,86x20:-85,0 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@72,73,86x20:-85,0']
- **pankki/kirjanpito-match-open** (Kirjanpito → Kohdista ostolaskujen maksut): late change [{'t': 4.06, 'area': 0.056, 'dy_pt': 0, 'what': 'pop'}]
- **offline/offline-tab-myynti** (Koti → tab Myynti (offline)): probe ['MOVE 1792073557.633 tab.myynti n=3 max=28 _SwiftUILayerDelegate@80,63,242x32:0,28 _SwiftUILayerDelegate@94,72,18x14:0,28 _SwiftUILayerDelegate@120,71,187x15:0,28']
