# Motion audit

94 steps. FAIL: intermediate 2, flash 0, shift (video) 8, shift (probe) 3; crashes 0.

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
| calibration | good-tab-kirjanpito | Koti → tab Kirjanpito | nav | NO | PASS | PASS | PASS | PASS | 1719 | 3 | [png](all/sheet-good-tab-kirjanpito.png) |
| calibration | bad-link-over-sheet | Asetukset sheet on Koti → Lasku (Myynti) | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-bad-link-over-sheet.png) |
| koti | koti-from-myynti-setup | launch → tab Koti | nav | yes | PASS | PASS | PASS | PASS | 11127 | 6 | [png](all/sheet-koti-from-myynti-setup.png) |
| koti | koti-refresh | Koti → Koti | load | yes | n/a | n/a | n/a | FAIL |  |  | no video |
| koti | koti-prev-month | Koti → Koti (previous month) | swap | yes | n/a | n/a | n/a | PASS |  |  | no video |
| koti | koti-next-month | Koti (previous month) → Koti | swap | yes | PASS | PASS | PASS | PASS | 3622 | 19 | [png](all/sheet-koti-next-month.png) |
| koti | koti-scroll | Koti → Koti | scroll | yes | PASS | PASS | n/a | PASS | 2821 | 92 | [png](all/sheet-koti-scroll.png) |
| koti | koti-settings-sheet | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-koti-settings-sheet.png) |
| koti | koti-settings-close | Asetukset sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3638 | 6 | [png](all/sheet-koti-settings-close.png) |
| koti | koti-assistant-sheet | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 3766 | 20 | [png](all/sheet-koti-assistant-sheet.png) |
| koti | koti-assistant-swipedown | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3655 | 95 | [png](all/sheet-koti-assistant-swipedown.png) |
| koti | koti-add-sheet | Koti → Lisää sheet | sheet | yes | PASS | PASS | FAIL | PASS | 957 | 13 | [png](all/sheet-koti-add-sheet.png) |
| koti | koti-add-close | Lisää sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 1083 | 7 | [png](all/sheet-koti-add-close.png) |
| myynti | myynti-tab | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-tab.png) |
| myynti | myynti-tab-revisit-koti | Myynti → tab Koti | nav | yes | PASS | PASS | FAIL | PASS | 1144 | 0 | [png](all/sheet-myynti-tab-revisit-koti.png) |
| myynti | myynti-tab-revisit | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 1589 | 2 | [png](all/sheet-myynti-tab-revisit.png) |
| myynti | myynti-refresh | Myynti → Myynti | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-refresh.png) |
| myynti | myynti-customers-open | Myynti → Asiakkaat | nav | yes | PASS | PASS | FAIL | PASS | 2504 | 10 | [png](all/sheet-myynti-customers-open.png) |
| myynti | myynti-customer-open | Asiakkaat → Asiakas | nav | yes | PASS | PASS | PASS | PASS | 2590 | 0 | [png](all/sheet-myynti-customer-open.png) |
| myynti | myynti-customer-back | Asiakas → Asiakkaat | nav | yes | PASS | PASS | FAIL | PASS | 1492 | 0 | [png](all/sheet-myynti-customer-back.png) |
| myynti | myynti-customers-swipeback | Asiakkaat → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1499 | 3 | [png](all/sheet-myynti-customers-swipeback.png) |
| myynti | myynti-recurring-open | Myynti → Toistuvat laskut | nav | yes | FAIL | PASS | FAIL | PASS | 1778 | 2 | [png](all/sheet-myynti-recurring-open.png) |
| myynti | myynti-recurring-swipeback | Toistuvat laskut → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1597 | 0 | [png](all/sheet-myynti-recurring-swipeback.png) |
| myynti | myynti-filter-late | Myynti → Laskut (myöhässä) | swap | yes | PASS | PASS | PASS | PASS | 2687 | 42 | [png](all/sheet-myynti-filter-late.png) |
| myynti | myynti-invoice-open | Myynti → Lasku | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-invoice-open.png) |
| myynti | myynti-invoice-scroll | Lasku → Lasku | scroll | yes | PASS | PASS | n/a | PASS | None | None | [png](all/sheet-myynti-invoice-scroll.png) |
| myynti | myynti-invoice-back | Lasku → Myynti | nav | yes | PASS | PASS | FAIL | PASS | 1982 | 3 | [png](all/sheet-myynti-invoice-back.png) |
| myynti | myynti-new-invoice | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | FAIL | 4785 | 17 | [png](all/sheet-myynti-new-invoice.png) |
| myynti | myynti-new-invoice-cancel | Uusi lasku → Myynti | sheet | yes | PASS | PASS | PASS | PASS | 2886 | 0 | [png](all/sheet-myynti-new-invoice-cancel.png) |
| myynti | myynti-list-scroll | Myynti → Myynti | scroll | yes | PASS | PASS | n/a | PASS | 694 | 1 | [png](all/sheet-myynti-list-scroll.png) |
| raportit | raportit-tab | Koti → tab Raportit | nav | yes | PASS | PASS | PASS | PASS | 2552 | 18 | [png](all/sheet-raportit-tab.png) |
| raportit | raportit-prev-year | Raportit → Raportit (previous year) | swap | yes | PASS | PASS | PASS | PASS | 3536 | 27 | [png](all/sheet-raportit-prev-year.png) |
| raportit | raportit-next-year | Raportit (previous year) → Raportit | swap | yes | PASS | PASS | PASS | PASS | 3251 | 12 | [png](all/sheet-raportit-next-year.png) |
| raportit | raportit-refresh | Raportit → Raportit | load | yes | n/a | PASS | PASS | PASS | 2348 | 72 | [png](all/sheet-raportit-refresh.png) |
| raportit | raportit-drill-open | Raportit → drill-down | nav | yes | PASS | PASS | FAIL | PASS | 753 | 0 | [png](all/sheet-raportit-drill-open.png) |
| raportit | raportit-drill-swipeback | drill-down → Raportit | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-raportit-drill-swipeback.png) |
| raportit | raportit-scroll | Raportit → Raportit | scroll | yes | PASS | PASS | n/a | PASS | 1357 | 41 | [png](all/sheet-raportit-scroll.png) |
| asetukset | asetukset-open | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 4855 | 46 | [png](all/sheet-asetukset-open.png) |
| asetukset | asetukset-seller-open | Asetukset → Laskuttajan tiedot | nav | yes | PASS | PASS | PASS | PASS | 2863 | 28 | [png](all/sheet-asetukset-seller-open.png) |
| asetukset | asetukset-seller-back | Laskuttajan tiedot → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1936 | 7 | [png](all/sheet-asetukset-seller-back.png) |
| asetukset | asetukset-templates-open | Asetukset → Sähköpostimallit | nav | yes | PASS | PASS | PASS | PASS | 2457 | 25 | [png](all/sheet-asetukset-templates-open.png) |
| asetukset | asetukset-templates-back | Sähköpostimallit → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1452 | 9 | [png](all/sheet-asetukset-templates-back.png) |
| asetukset | asetukset-payments-open | Asetukset → Maksut | nav | yes | PASS | PASS | PASS | PASS | 2501 | 17 | [png](all/sheet-asetukset-payments-open.png) |
| asetukset | asetukset-payments-back | Maksut → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1610 | 18 | [png](all/sheet-asetukset-payments-back.png) |
| asetukset | asetukset-password-open | Asetukset → Vaihda salasana | nav | yes | PASS | PASS | PASS | PASS | 3040 | 15 | [png](all/sheet-asetukset-password-open.png) |
| asetukset | asetukset-password-back | Vaihda salasana → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1682 | 17 | [png](all/sheet-asetukset-password-back.png) |
| asetukset | asetukset-passkeys-open | Asetukset → Pääsyavaimet | nav | yes | PASS | PASS | PASS | PASS | 2788 | 18 | [png](all/sheet-asetukset-passkeys-open.png) |
| asetukset | asetukset-passkeys-back | Pääsyavaimet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1482 | 20 | [png](all/sheet-asetukset-passkeys-back.png) |
| asetukset | asetukset-devices-open | Asetukset → Laitteet | nav | yes | PASS | PASS | PASS | PASS | 2245 | 15 | [png](all/sheet-asetukset-devices-open.png) |
| asetukset | asetukset-devices-back | Laitteet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1436 | 19 | [png](all/sheet-asetukset-devices-back.png) |
| asetukset | asetukset-lock-open | Asetukset → Sovelluslukitus | nav | yes | PASS | PASS | PASS | PASS | 2154 | 9 | [png](all/sheet-asetukset-lock-open.png) |
| asetukset | asetukset-lock-back | Sovelluslukitus → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1361 | 20 | [png](all/sheet-asetukset-lock-back.png) |
| asetukset | asetukset-notifications-open | Asetukset → Ilmoitukset | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-notifications-open.png) |
| asetukset | asetukset-notifications-back | Ilmoitukset → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1511 | 15 | [png](all/sheet-asetukset-notifications-back.png) |
| asetukset | asetukset-privacy-open | Asetukset → Tietosuoja | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-privacy-open.png) |
| asetukset | asetukset-privacy-back | Tietosuoja → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1722 | 0 | [png](all/sheet-asetukset-privacy-back.png) |
| asetukset | asetukset-close | Asetukset sheet → Koti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-close.png) |
| chat | chat-open | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 2153 | 27 | [png](all/sheet-chat-open.png) |
| chat | chat-focus | Avustaja → Avustaja (keyboard) | swap | yes | PASS | PASS | PASS | PASS | 1801 | 14 | [png](all/sheet-chat-focus.png) |
| chat | chat-send | Avustaja → Avustaja (answer) | load | yes | n/a | PASS | FAIL | PASS | 1810 | 0 | [png](all/sheet-chat-send.png) |
| chat | chat-close | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3272 | 128 | [png](all/sheet-chat-close.png) |
| lasku | lasku-new | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | PASS | 2844 | 42 | [png](all/sheet-lasku-new.png) |
| lasku | lasku-customer-picker | Uusi lasku → asiakasvalinta | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-customer-picker.png) |
| lasku | lasku-customer-cancel | asiakasvalinta → Uusi lasku | nav | yes | PASS | PASS | PASS | PASS | 1800 | 12 | [png](all/sheet-lasku-customer-cancel.png) |
| lasku | lasku-form-scroll | Uusi lasku → Uusi lasku | scroll | yes | PASS | PASS | n/a | PASS | 2406 | 39 | [png](all/sheet-lasku-form-scroll.png) |
| lasku | lasku-cancel | Uusi lasku → Myynti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-cancel.png) |
| lasku | lasku-open | Myynti → Lasku | nav | yes | PASS | PASS | PASS | PASS | 2976 | 13 | [png](all/sheet-lasku-open.png) |
| lasku | lasku-copy | Lasku → Uusi lasku (copy) | sheet | yes | PASS | PASS | PASS | PASS | 2201 | 19 | [png](all/sheet-lasku-copy.png) |
| lasku | lasku-copy-cancel | Uusi lasku (copy) → Lasku | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-copy-cancel.png) |
| lasku | lasku-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1500 | 23 | [png](all/sheet-lasku-back.png) |
| pankki | pankki-kirjanpito-tab | Koti → tab Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1705 | 5 | [png](all/sheet-pankki-kirjanpito-tab.png) |
| pankki | pankki-hub-open | Kirjanpito → Pankki | nav | yes | PASS | PASS | PASS | PASS | 1824 | 17 | [png](all/sheet-pankki-hub-open.png) |
| pankki | pankki-feed-open | Pankki → Pankkitapahtumat | nav | yes | PASS | PASS | PASS | PASS | 2492 | 29 | [png](all/sheet-pankki-feed-open.png) |
| pankki | pankki-feed-scroll | Pankkitapahtumat → Pankkitapahtumat | scroll | yes | PASS | PASS | n/a | PASS | 1483 | 39 | [png](all/sheet-pankki-feed-scroll.png) |
| pankki | pankki-feed-more | Pankkitapahtumat → Pankkitapahtumat (more) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-pankki-feed-more.png) |
| pankki | pankki-feed-back | Pankkitapahtumat → Pankki | nav | yes | PASS | PASS | PASS | PASS | 1534 | 33 | [png](all/sheet-pankki-feed-back.png) |
| pankki | pankki-accounts-open | Pankki → Pankkiyhteys ja tilit | nav | yes | PASS | PASS | PASS | PASS | 2069 | 17 | [png](all/sheet-pankki-accounts-open.png) |
| pankki | pankki-accounts-back | Pankkiyhteys ja tilit → Pankki | nav | yes | PASS | PASS | PASS | PASS | 1349 | 18 | [png](all/sheet-pankki-accounts-back.png) |
| pankki | pankki-hub-back | Pankki → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1615 | 18 | [png](all/sheet-pankki-hub-back.png) |
| pankki | kirjanpito-email-open | Kirjanpito → Sähköposti | nav | yes | PASS | PASS | PASS | PASS | 1937 | 15 | [png](all/sheet-kirjanpito-email-open.png) |
| pankki | kirjanpito-email-back | Sähköposti → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1802 | 41 | [png](all/sheet-kirjanpito-email-back.png) |
| pankki | kirjanpito-purchases-open | Kirjanpito → Ostolaskut | nav | yes | PASS | PASS | PASS | PASS | 2027 | 15 | [png](all/sheet-kirjanpito-purchases-open.png) |
| pankki | kirjanpito-purchases-back | Ostolaskut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1407 | 26 | [png](all/sheet-kirjanpito-purchases-back.png) |
| pankki | kirjanpito-match-open | Kirjanpito → Kohdista ostolaskujen maksut | nav | yes | PASS | PASS | PASS | PASS | 1757 | 13 | [png](all/sheet-kirjanpito-match-open.png) |
| pankki | kirjanpito-match-back | Kohdista ostolaskujen maksut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1433 | 38 | [png](all/sheet-kirjanpito-match-back.png) |
| pankki | kirjanpito-periods-open | Kirjanpito → Kuukauden sulku | nav | yes | PASS | PASS | PASS | PASS | 1925 | 13 | [png](all/sheet-kirjanpito-periods-open.png) |
| pankki | kirjanpito-periods-back | Kuukauden sulku → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1648 | 38 | [png](all/sheet-kirjanpito-periods-back.png) |
| pankki | kirjanpito-alv-open | Kirjanpito → ALV-ilmoitus | nav | yes | PASS | PASS | PASS | PASS | 2644 | 28 | [png](all/sheet-kirjanpito-alv-open.png) |
| pankki | kirjanpito-alv-back | ALV-ilmoitus → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1372 | 37 | [png](all/sheet-kirjanpito-alv-back.png) |
| pankki | kirjanpito-ledger-open | Kirjanpito → Kirjanpito, Tuloslaskelma | nav | yes | PASS | PASS | PASS | PASS | 2151 | 21 | [png](all/sheet-kirjanpito-ledger-open.png) |
| pankki | kirjanpito-ledger-back | Kirjanpito, Tuloslaskelma → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1383 | 36 | [png](all/sheet-kirjanpito-ledger-back.png) |
| offline | offline-tab-myynti | Koti → tab Myynti (offline) | nav | yes | FAIL | PASS | PASS | FAIL | 2043 | 30 | [png](all/sheet-offline-tab-myynti.png) |
| offline | offline-refresh | Myynti → Myynti (offline error) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-offline-refresh.png) |
| offline | online-again | Myynti (offline) → Myynti | load | yes | n/a | PASS | PASS | PASS | 4050 | 0 | [png](all/sheet-online-again.png) |

## Details of FAIL rows

- **koti/koti-refresh** (Koti → Koti): probe ['MOVE 1792076159.033 tab.koti n=1 max=60 NavigationBarLargeTitleView@0,116,402x52:0,-60', 'SCROLLJUMP 1792076159.112 tab.koti dy=10', 'MOVE 1792076159.122 tab.koti n=108 max=10 _UITouchPassthroughView@0,-217,402x874:0,10 BackdropView@0,-217,402x170:0,10 _UITouchPassthroughView@0,-217,402x874:0,10']
- **koti/koti-add-sheet** (Koti → Lisää sheet): late change [{'t': 1.87, 'area': 0.084, 'dy_pt': 0, 'what': 'pop'}, {'t': 1.94, 'area': 0.042, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.01, 'area': 0.081, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.08, 'area': 0.08, 'dy_pt': -28, 'what': 'move'}, {'t': 2.1, 'area': 0.033, 'dy_pt': -10, 'what': 'move'}, {'t': 2.12, 'area': 0.02, 'dy_pt': -4, 'what': 'move'}, {'t': 2.18, 'area': 0.015, 'dy_pt': -2, 'what': 'pop'}, {'t': 2.28, 'area': 0.038, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-tab-revisit-koti** (Myynti → tab Koti): late change [{'t': 1.88, 'area': 0.091, 'dy_pt': 0, 'what': 'pop'}, {'t': 1.95, 'area': 0.112, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-customers-open** (Myynti → Asiakkaat): late change [{'t': 3.69, 'area': 0.024, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-customer-back** (Asiakas → Asiakkaat): late change [{'t': 2.2, 'area': 0.051, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-recurring-open** (Myynti → Toistuvat laskut): intermediate screens [{'frame': 5, 't': 2.43, 'held_s': 0.38, 'd_start': 10.9, 'd_end': 11.2}]; late change [{'t': 2.43, 'area': 0.027, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.8, 'area': 0.056, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-invoice-back** (Lasku → Myynti): late change [{'t': 2.73, 'area': 0.027, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-new-invoice** (Myynti → Uusi lasku): probe ['MOVE 1792076583.298 tab.myynti n=3 max=25 HostedViewWrapper@135,83,132x34:-25,-6 _UINavigationBarTitleControl@135,83,132x34:-25,-6 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@135,83,132x34:-25,-6']
- **raportit/raportit-drill-open** (Raportit → drill-down): late change [{'t': 1.82, 'area': 0.048, 'dy_pt': 0, 'what': 'pop'}, {'t': 1.95, 'area': 0.018, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.25, 'area': 0.052, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-send** (Avustaja → Avustaja (answer)): intermediate screens [{'frame': 27, 't': 1.81, 'held_s': 0.81, 'd_start': 9.3, 'd_end': 12.0}]; late change [{'t': 2.65, 'area': 0.083, 'dy_pt': 0, 'what': 'pop'}]
- **offline/offline-tab-myynti** (Koti → tab Myynti (offline)): intermediate screens [{'frame': 38, 't': 1.56, 'held_s': 0.48, 'd_start': 10.6, 'd_end': 12.7}]; probe ['MOVE 1792077544.720 tab.myynti n=3 max=18 _SwiftUILayerDelegate@80,64,242x32:0,18 _SwiftUILayerDelegate@94,73,18x14:0,18 _SwiftUILayerDelegate@120,72,187x15:0,18']
