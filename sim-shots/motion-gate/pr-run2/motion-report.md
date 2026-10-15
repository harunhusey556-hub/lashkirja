# Motion audit

94 steps. FAIL: intermediate 1, flash 0, shift (video) 5, shift (probe) 1; crashes 0.

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
| calibration | good-tab-kirjanpito | Koti → tab Kirjanpito | nav | NO | PASS | PASS | PASS | PASS | 1467 | 5 | [png](all/sheet-good-tab-kirjanpito.png) |
| calibration | bad-link-over-sheet | Asetukset sheet on Koti → Lasku (Myynti) | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-bad-link-over-sheet.png) |
| koti | koti-from-myynti-setup | launch → tab Koti | nav | yes | PASS | PASS | PASS | PASS | 1206 | 17 | [png](all/sheet-koti-from-myynti-setup.png) |
| koti | koti-refresh | Koti → Koti | load | yes | n/a | PASS | PASS | PASS | 2844 | 101 | [png](all/sheet-koti-refresh.png) |
| koti | koti-prev-month | Koti → Koti (previous month) | swap | yes | PASS | PASS | PASS | PASS | 3332 | 10 | [png](all/sheet-koti-prev-month.png) |
| koti | koti-next-month | Koti (previous month) → Koti | swap | yes | PASS | PASS | PASS | PASS | 2909 | 15 | [png](all/sheet-koti-next-month.png) |
| koti | koti-scroll | Koti → Koti | scroll | yes | PASS | PASS | n/a | PASS | 2597 | 97 | [png](all/sheet-koti-scroll.png) |
| koti | koti-settings-sheet | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 2747 | 15 | [png](all/sheet-koti-settings-sheet.png) |
| koti | koti-settings-close | Asetukset sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 2799 | 11 | [png](all/sheet-koti-settings-close.png) |
| koti | koti-assistant-sheet | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 3366 | 35 | [png](all/sheet-koti-assistant-sheet.png) |
| koti | koti-assistant-swipedown | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3172 | 56 | [png](all/sheet-koti-assistant-swipedown.png) |
| koti | koti-add-sheet | Koti → Lisää sheet | sheet | yes | PASS | PASS | FAIL | PASS | 1069 | 0 | [png](all/sheet-koti-add-sheet.png) |
| koti | koti-add-close | Lisää sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 1601 | 10 | [png](all/sheet-koti-add-close.png) |
| myynti | myynti-tab | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 2776 | 5 | [png](all/sheet-myynti-tab.png) |
| myynti | myynti-tab-revisit-koti | Myynti → tab Koti | nav | yes | PASS | PASS | PASS | PASS | 1125 | 1 | [png](all/sheet-myynti-tab-revisit-koti.png) |
| myynti | myynti-tab-revisit | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 1404 | 4 | [png](all/sheet-myynti-tab-revisit.png) |
| myynti | myynti-refresh | Myynti → Myynti | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-refresh.png) |
| myynti | myynti-customers-open | Myynti → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 2373 | 0 | [png](all/sheet-myynti-customers-open.png) |
| myynti | myynti-customer-open | Asiakkaat → Asiakas | nav | yes | PASS | PASS | PASS | PASS | 2331 | 20 | [png](all/sheet-myynti-customer-open.png) |
| myynti | myynti-customer-back | Asiakas → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 2102 | 8 | [png](all/sheet-myynti-customer-back.png) |
| myynti | myynti-customers-swipeback | Asiakkaat → Myynti | nav | yes | PASS | PASS | PASS | PASS | 2151 | 12 | [png](all/sheet-myynti-customers-swipeback.png) |
| myynti | myynti-recurring-open | Myynti → Toistuvat laskut | nav | yes | PASS | PASS | PASS | PASS | 2295 | 1 | [png](all/sheet-myynti-recurring-open.png) |
| myynti | myynti-recurring-swipeback | Toistuvat laskut → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1821 | 0 | [png](all/sheet-myynti-recurring-swipeback.png) |
| myynti | myynti-filter-late | Myynti → Laskut (myöhässä) | swap | yes | PASS | PASS | FAIL | PASS | 2172 | 0 | [png](all/sheet-myynti-filter-late.png) |
| myynti | myynti-invoice-open | Myynti → Lasku | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-invoice-open.png) |
| myynti | myynti-invoice-scroll | Lasku → Lasku | scroll | yes | PASS | PASS | n/a | PASS | 243 | 0 | [png](all/sheet-myynti-invoice-scroll.png) |
| myynti | myynti-invoice-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 2262 | 41 | [png](all/sheet-myynti-invoice-back.png) |
| myynti | myynti-new-invoice | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | PASS | 3346 | 0 | [png](all/sheet-myynti-new-invoice.png) |
| myynti | myynti-new-invoice-cancel | Uusi lasku → Myynti | sheet | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-new-invoice-cancel.png) |
| myynti | myynti-list-scroll | Myynti → Myynti | scroll | yes | PASS | PASS | n/a | PASS | None | None | [png](all/sheet-myynti-list-scroll.png) |
| raportit | raportit-tab | Koti → tab Raportit | nav | yes | PASS | PASS | PASS | PASS | 2419 | 20 | [png](all/sheet-raportit-tab.png) |
| raportit | raportit-prev-year | Raportit → Raportit (previous year) | swap | yes | PASS | PASS | PASS | PASS | 4301 | 16 | [png](all/sheet-raportit-prev-year.png) |
| raportit | raportit-next-year | Raportit (previous year) → Raportit | swap | yes | PASS | PASS | PASS | PASS | 3601 | 2 | [png](all/sheet-raportit-next-year.png) |
| raportit | raportit-refresh | Raportit → Raportit | load | yes | n/a | PASS | PASS | PASS | 2101 | 68 | [png](all/sheet-raportit-refresh.png) |
| raportit | raportit-drill-open | Raportit → drill-down | nav | yes | PASS | PASS | FAIL | PASS | 1290 | 0 | [png](all/sheet-raportit-drill-open.png) |
| raportit | raportit-drill-swipeback | drill-down → Raportit | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-raportit-drill-swipeback.png) |
| raportit | raportit-scroll | Raportit → Raportit | scroll | yes | PASS | PASS | n/a | PASS | 1270 | 39 | [png](all/sheet-raportit-scroll.png) |
| asetukset | asetukset-open | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 4242 | 0 | [png](all/sheet-asetukset-open.png) |
| asetukset | asetukset-seller-open | Asetukset → Laskuttajan tiedot | nav | yes | PASS | PASS | PASS | PASS | 3222 | 17 | [png](all/sheet-asetukset-seller-open.png) |
| asetukset | asetukset-seller-back | Laskuttajan tiedot → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2074 | 24 | [png](all/sheet-asetukset-seller-back.png) |
| asetukset | asetukset-templates-open | Asetukset → Sähköpostimallit | nav | yes | PASS | PASS | PASS | PASS | 2621 | 12 | [png](all/sheet-asetukset-templates-open.png) |
| asetukset | asetukset-templates-back | Sähköpostimallit → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1886 | 22 | [png](all/sheet-asetukset-templates-back.png) |
| asetukset | asetukset-payments-open | Asetukset → Maksut | nav | yes | PASS | PASS | PASS | PASS | 3715 | 20 | [png](all/sheet-asetukset-payments-open.png) |
| asetukset | asetukset-payments-back | Maksut → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1843 | 22 | [png](all/sheet-asetukset-payments-back.png) |
| asetukset | asetukset-password-open | Asetukset → Vaihda salasana | nav | yes | PASS | PASS | PASS | PASS | 3169 | 15 | [png](all/sheet-asetukset-password-open.png) |
| asetukset | asetukset-password-back | Vaihda salasana → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2080 | 26 | [png](all/sheet-asetukset-password-back.png) |
| asetukset | asetukset-passkeys-open | Asetukset → Pääsyavaimet | nav | yes | PASS | PASS | PASS | PASS | 3915 | 0 | [png](all/sheet-asetukset-passkeys-open.png) |
| asetukset | asetukset-passkeys-back | Pääsyavaimet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2249 | 16 | [png](all/sheet-asetukset-passkeys-back.png) |
| asetukset | asetukset-devices-open | Asetukset → Laitteet | nav | yes | PASS | PASS | PASS | PASS | 3535 | 0 | [png](all/sheet-asetukset-devices-open.png) |
| asetukset | asetukset-devices-back | Laitteet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1681 | 11 | [png](all/sheet-asetukset-devices-back.png) |
| asetukset | asetukset-lock-open | Asetukset → Sovelluslukitus | nav | yes | PASS | PASS | PASS | PASS | 2547 | 13 | [png](all/sheet-asetukset-lock-open.png) |
| asetukset | asetukset-lock-back | Sovelluslukitus → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1612 | 22 | [png](all/sheet-asetukset-lock-back.png) |
| asetukset | asetukset-notifications-open | Asetukset → Ilmoitukset | nav | yes | PASS | PASS | PASS | PASS | 3602 | 6 | [png](all/sheet-asetukset-notifications-open.png) |
| asetukset | asetukset-notifications-back | Ilmoitukset → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1870 | 27 | [png](all/sheet-asetukset-notifications-back.png) |
| asetukset | asetukset-privacy-open | Asetukset → Tietosuoja | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-privacy-open.png) |
| asetukset | asetukset-privacy-back | Tietosuoja → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1944 | 0 | [png](all/sheet-asetukset-privacy-back.png) |
| asetukset | asetukset-close | Asetukset sheet → Koti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-close.png) |
| chat | chat-open | Koti → Avustaja | sheet | yes | PASS | PASS | FAIL | PASS | 2651 | 13 | [png](all/sheet-chat-open.png) |
| chat | chat-focus | Avustaja → Avustaja (keyboard) | swap | yes | PASS | PASS | PASS | PASS | 2638 | 27 | [png](all/sheet-chat-focus.png) |
| chat | chat-send | Avustaja → Avustaja (answer) | load | yes | n/a | PASS | FAIL | PASS | 2922 | 0 | [png](all/sheet-chat-send.png) |
| chat | chat-close | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3430 | 133 | [png](all/sheet-chat-close.png) |
| lasku | lasku-new | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | PASS | 2705 | 31 | [png](all/sheet-lasku-new.png) |
| lasku | lasku-customer-picker | Uusi lasku → asiakasvalinta | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-customer-picker.png) |
| lasku | lasku-customer-cancel | asiakasvalinta → Uusi lasku | nav | yes | PASS | PASS | PASS | PASS | 3574 | 10 | [png](all/sheet-lasku-customer-cancel.png) |
| lasku | lasku-form-scroll | Uusi lasku → Uusi lasku | scroll | yes | PASS | PASS | n/a | PASS | 1673 | 43 | [png](all/sheet-lasku-form-scroll.png) |
| lasku | lasku-cancel | Uusi lasku → Myynti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-cancel.png) |
| lasku | lasku-open | Myynti → Lasku | nav | yes | FAIL | PASS | PASS | PASS | 3796 | 39 | [png](all/sheet-lasku-open.png) |
| lasku | lasku-copy | Lasku → Uusi lasku (copy) | sheet | yes | PASS | PASS | PASS | PASS | 2181 | 6 | [png](all/sheet-lasku-copy.png) |
| lasku | lasku-copy-cancel | Uusi lasku (copy) → Lasku | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-copy-cancel.png) |
| lasku | lasku-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1627 | 13 | [png](all/sheet-lasku-back.png) |
| pankki | pankki-kirjanpito-tab | Koti → tab Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2449 | 18 | [png](all/sheet-pankki-kirjanpito-tab.png) |
| pankki | pankki-hub-open | Kirjanpito → Pankki | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-pankki-hub-open.png) |
| pankki | pankki-feed-open | Pankki → Pankkitapahtumat | nav | yes | PASS | PASS | PASS | PASS | 2756 | 24 | [png](all/sheet-pankki-feed-open.png) |
| pankki | pankki-feed-scroll | Pankkitapahtumat → Pankkitapahtumat | scroll | yes | PASS | PASS | n/a | PASS | 1757 | 36 | [png](all/sheet-pankki-feed-scroll.png) |
| pankki | pankki-feed-more | Pankkitapahtumat → Pankkitapahtumat (more) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-pankki-feed-more.png) |
| pankki | pankki-feed-back | Pankkitapahtumat → Pankki | nav | yes | PASS | PASS | PASS | PASS | 1731 | 23 | [png](all/sheet-pankki-feed-back.png) |
| pankki | pankki-accounts-open | Pankki → Pankkiyhteys ja tilit | nav | yes | PASS | PASS | PASS | PASS | 2685 | 20 | [png](all/sheet-pankki-accounts-open.png) |
| pankki | pankki-accounts-back | Pankkiyhteys ja tilit → Pankki | nav | yes | PASS | PASS | PASS | PASS | 1399 | 12 | [png](all/sheet-pankki-accounts-back.png) |
| pankki | pankki-hub-back | Pankki → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1315 | 13 | [png](all/sheet-pankki-hub-back.png) |
| pankki | kirjanpito-email-open | Kirjanpito → Sähköposti | nav | yes | PASS | PASS | PASS | PASS | 1783 | 21 | [png](all/sheet-kirjanpito-email-open.png) |
| pankki | kirjanpito-email-back | Sähköposti → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1584 | 34 | [png](all/sheet-kirjanpito-email-back.png) |
| pankki | kirjanpito-purchases-open | Kirjanpito → Ostolaskut | nav | yes | PASS | PASS | PASS | PASS | 3921 | 44 | [png](all/sheet-kirjanpito-purchases-open.png) |
| pankki | kirjanpito-purchases-back | Ostolaskut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2122 | 30 | [png](all/sheet-kirjanpito-purchases-back.png) |
| pankki | kirjanpito-match-open | Kirjanpito → Kohdista ostolaskujen maksut | nav | yes | PASS | PASS | PASS | PASS | 3480 | 17 | [png](all/sheet-kirjanpito-match-open.png) |
| pankki | kirjanpito-match-back | Kohdista ostolaskujen maksut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1802 | 37 | [png](all/sheet-kirjanpito-match-back.png) |
| pankki | kirjanpito-periods-open | Kirjanpito → Kuukauden sulku | nav | yes | PASS | PASS | PASS | PASS | 2318 | 32 | [png](all/sheet-kirjanpito-periods-open.png) |
| pankki | kirjanpito-periods-back | Kuukauden sulku → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1827 | 35 | [png](all/sheet-kirjanpito-periods-back.png) |
| pankki | kirjanpito-alv-open | Kirjanpito → ALV-ilmoitus | nav | yes | PASS | PASS | PASS | PASS | 2119 | 22 | [png](all/sheet-kirjanpito-alv-open.png) |
| pankki | kirjanpito-alv-back | ALV-ilmoitus → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1482 | 33 | [png](all/sheet-kirjanpito-alv-back.png) |
| pankki | kirjanpito-ledger-open | Kirjanpito → Kirjanpito, Tuloslaskelma | nav | yes | PASS | PASS | PASS | PASS | 2624 | 25 | [png](all/sheet-kirjanpito-ledger-open.png) |
| pankki | kirjanpito-ledger-back | Kirjanpito, Tuloslaskelma → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1572 | 34 | [png](all/sheet-kirjanpito-ledger-back.png) |
| offline | offline-tab-myynti | Koti → tab Myynti (offline) | nav | yes | PASS | PASS | PASS | FAIL | 2409 | 14 | [png](all/sheet-offline-tab-myynti.png) |
| offline | offline-refresh | Myynti → Myynti (offline error) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-offline-refresh.png) |
| offline | online-again | Myynti (offline) → Myynti | load | yes | n/a | PASS | PASS | PASS | 6086 | 1 | [png](all/sheet-online-again.png) |

## Details of FAIL rows

- **koti/koti-add-sheet** (Koti → Lisää sheet): late change [{'t': 2.31, 'area': 0.091, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.41, 'area': 0.149, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.44, 'area': 0.026, 'dy_pt': -5, 'what': 'move'}, {'t': 2.64, 'area': 0.032, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-filter-late** (Myynti → Laskut (myöhässä)): late change [{'t': 3.49, 'area': 0.179, 'dy_pt': 0, 'what': 'pop'}]
- **raportit/raportit-drill-open** (Raportit → drill-down): late change [{'t': 1.94, 'area': 0.075, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.17, 'area': 0.052, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-open** (Koti → Avustaja): late change [{'t': 3.34, 'area': 0.017, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-send** (Avustaja → Avustaja (answer)): late change [{'t': 4.84, 'area': 0.074, 'dy_pt': 0, 'what': 'pop'}]
- **lasku/lasku-open** (Myynti → Lasku): intermediate screens [{'frame': 7, 't': 3.46, 'held_s': 0.34, 'd_start': 9.6, 'd_end': 17.3}]
- **offline/offline-tab-myynti** (Koti → tab Myynti (offline)): probe ['MOVE 1792070058.373 tab.myynti n=3 max=22 _SwiftUILayerDelegate@80,53,242x32:0,22 _SwiftUILayerDelegate@94,62,18x14:0,22 _SwiftUILayerDelegate@120,61,187x15:0,22', 'MOVE 1792070058.466 tab.myynti n=3 max=12 _SwiftUILayerDelegate@80,66,242x32:0,12 _SwiftUILayerDelegate@94,75,18x14:0,12 _SwiftUILayerDelegate@120,74,187x15:0,12']
