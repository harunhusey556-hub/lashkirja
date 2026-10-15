# Motion audit

94 steps. FAIL: intermediate 2, flash 0, shift (video) 8, shift (probe) 5; crashes 0.

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
| calibration | good-tab-kirjanpito | Koti → tab Kirjanpito | nav | NO | PASS | PASS | PASS | PASS | 4239 | 5 | [png](all/sheet-good-tab-kirjanpito.png) |
| calibration | bad-link-over-sheet | Asetukset sheet on Koti → Lasku (Myynti) | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-bad-link-over-sheet.png) |
| koti | koti-from-myynti-setup | launch → tab Koti | nav | yes | PASS | PASS | PASS | PASS | 1771 | 0 | [png](all/sheet-koti-from-myynti-setup.png) |
| koti | koti-refresh | Koti → Koti | load | yes | n/a | PASS | PASS | PASS | 2395 | 61 | [png](all/sheet-koti-refresh.png) |
| koti | koti-prev-month | Koti → Koti (previous month) | swap | yes | PASS | PASS | FAIL | PASS | 3214 | 0 | [png](all/sheet-koti-prev-month.png) |
| koti | koti-next-month | Koti (previous month) → Koti | swap | yes | PASS | PASS | PASS | PASS | 3548 | 17 | [png](all/sheet-koti-next-month.png) |
| koti | koti-scroll | Koti → Koti | scroll | yes | PASS | PASS | n/a | PASS | 2545 | 107 | [png](all/sheet-koti-scroll.png) |
| koti | koti-settings-sheet | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 4853 | 20 | [png](all/sheet-koti-settings-sheet.png) |
| koti | koti-settings-close | Asetukset sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-koti-settings-close.png) |
| koti | koti-assistant-sheet | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 3003 | 26 | [png](all/sheet-koti-assistant-sheet.png) |
| koti | koti-assistant-swipedown | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 2870 | 85 | [png](all/sheet-koti-assistant-swipedown.png) |
| koti | koti-add-sheet | Koti → Lisää sheet | sheet | yes | PASS | PASS | FAIL | PASS | 996 | 7 | [png](all/sheet-koti-add-sheet.png) |
| koti | koti-add-close | Lisää sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 2066 | 3 | [png](all/sheet-koti-add-close.png) |
| myynti | myynti-tab | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 2954 | 10 | [png](all/sheet-myynti-tab.png) |
| myynti | myynti-tab-revisit-koti | Myynti → tab Koti | nav | yes | PASS | PASS | FAIL | PASS | 1139 | 0 | [png](all/sheet-myynti-tab-revisit-koti.png) |
| myynti | myynti-tab-revisit | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 1362 | 3 | [png](all/sheet-myynti-tab-revisit.png) |
| myynti | myynti-refresh | Myynti → Myynti | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-refresh.png) |
| myynti | myynti-customers-open | Myynti → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 3015 | 21 | [png](all/sheet-myynti-customers-open.png) |
| myynti | myynti-customer-open | Asiakkaat → Asiakas | nav | yes | PASS | PASS | PASS | PASS | 2047 | 13 | [png](all/sheet-myynti-customer-open.png) |
| myynti | myynti-customer-back | Asiakas → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 2037 | 13 | [png](all/sheet-myynti-customer-back.png) |
| myynti | myynti-customers-swipeback | Asiakkaat → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1686 | 36 | [png](all/sheet-myynti-customers-swipeback.png) |
| myynti | myynti-recurring-open | Myynti → Toistuvat laskut | nav | yes | FAIL | PASS | PASS | PASS | 3180 | 47 | [png](all/sheet-myynti-recurring-open.png) |
| myynti | myynti-recurring-swipeback | Toistuvat laskut → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1541 | 25 | [png](all/sheet-myynti-recurring-swipeback.png) |
| myynti | myynti-filter-late | Myynti → Laskut (myöhässä) | swap | yes | FAIL | PASS | FAIL | FAIL | 2568 | 29 | [png](all/sheet-myynti-filter-late.png) |
| myynti | myynti-invoice-open | Myynti → Lasku | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-invoice-open.png) |
| myynti | myynti-invoice-scroll | Lasku → Lasku | scroll | yes | PASS | PASS | n/a | PASS | 1444 | 39 | [png](all/sheet-myynti-invoice-scroll.png) |
| myynti | myynti-invoice-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 2572 | 21 | [png](all/sheet-myynti-invoice-back.png) |
| myynti | myynti-new-invoice | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | PASS | 3885 | 61 | [png](all/sheet-myynti-new-invoice.png) |
| myynti | myynti-new-invoice-cancel | Uusi lasku → Myynti | sheet | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-new-invoice-cancel.png) |
| myynti | myynti-list-scroll | Myynti → Myynti | scroll | yes | PASS | PASS | n/a | PASS | 1549 | 33 | [png](all/sheet-myynti-list-scroll.png) |
| raportit | raportit-tab | Koti → tab Raportit | nav | yes | PASS | PASS | PASS | PASS | 4064 | 0 | [png](all/sheet-raportit-tab.png) |
| raportit | raportit-prev-year | Raportit → Raportit (previous year) | swap | yes | PASS | PASS | PASS | FAIL | 4283 | 0 | [png](all/sheet-raportit-prev-year.png) |
| raportit | raportit-next-year | Raportit (previous year) → Raportit | swap | yes | PASS | PASS | PASS | PASS | 5136 | 7 | [png](all/sheet-raportit-next-year.png) |
| raportit | raportit-refresh | Raportit → Raportit | load | yes | n/a | PASS | PASS | PASS | 2846 | 102 | [png](all/sheet-raportit-refresh.png) |
| raportit | raportit-drill-open | Raportit → drill-down | nav | yes | PASS | PASS | FAIL | PASS | 1476 | 0 | [png](all/sheet-raportit-drill-open.png) |
| raportit | raportit-drill-swipeback | drill-down → Raportit | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-raportit-drill-swipeback.png) |
| raportit | raportit-scroll | Raportit → Raportit | scroll | yes | PASS | PASS | n/a | PASS | 1611 | 37 | [png](all/sheet-raportit-scroll.png) |
| asetukset | asetukset-open | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 4047 | 25 | [png](all/sheet-asetukset-open.png) |
| asetukset | asetukset-seller-open | Asetukset → Laskuttajan tiedot | nav | yes | PASS | PASS | PASS | PASS | 3284 | 15 | [png](all/sheet-asetukset-seller-open.png) |
| asetukset | asetukset-seller-back | Laskuttajan tiedot → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 3547 | 21 | [png](all/sheet-asetukset-seller-back.png) |
| asetukset | asetukset-templates-open | Asetukset → Sähköpostimallit | nav | yes | PASS | PASS | PASS | PASS | 2747 | 19 | [png](all/sheet-asetukset-templates-open.png) |
| asetukset | asetukset-templates-back | Sähköpostimallit → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2290 | 21 | [png](all/sheet-asetukset-templates-back.png) |
| asetukset | asetukset-payments-open | Asetukset → Maksut | nav | yes | PASS | PASS | PASS | PASS | 3038 | 20 | [png](all/sheet-asetukset-payments-open.png) |
| asetukset | asetukset-payments-back | Maksut → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2233 | 11 | [png](all/sheet-asetukset-payments-back.png) |
| asetukset | asetukset-password-open | Asetukset → Vaihda salasana | nav | yes | PASS | PASS | PASS | PASS | 3472 | 10 | [png](all/sheet-asetukset-password-open.png) |
| asetukset | asetukset-password-back | Vaihda salasana → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2223 | 15 | [png](all/sheet-asetukset-password-back.png) |
| asetukset | asetukset-passkeys-open | Asetukset → Pääsyavaimet | nav | yes | PASS | PASS | FAIL | PASS | 3954 | 17 | [png](all/sheet-asetukset-passkeys-open.png) |
| asetukset | asetukset-passkeys-back | Pääsyavaimet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1806 | 13 | [png](all/sheet-asetukset-passkeys-back.png) |
| asetukset | asetukset-devices-open | Asetukset → Laitteet | nav | yes | PASS | PASS | PASS | PASS | 3401 | 17 | [png](all/sheet-asetukset-devices-open.png) |
| asetukset | asetukset-devices-back | Laitteet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1857 | 16 | [png](all/sheet-asetukset-devices-back.png) |
| asetukset | asetukset-lock-open | Asetukset → Sovelluslukitus | nav | yes | PASS | PASS | PASS | PASS | 3286 | 14 | [png](all/sheet-asetukset-lock-open.png) |
| asetukset | asetukset-lock-back | Sovelluslukitus → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1844 | 15 | [png](all/sheet-asetukset-lock-back.png) |
| asetukset | asetukset-notifications-open | Asetukset → Ilmoitukset | nav | yes | PASS | PASS | PASS | PASS | 3183 | 25 | [png](all/sheet-asetukset-notifications-open.png) |
| asetukset | asetukset-notifications-back | Ilmoitukset → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1581 | 17 | [png](all/sheet-asetukset-notifications-back.png) |
| asetukset | asetukset-privacy-open | Asetukset → Tietosuoja | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-privacy-open.png) |
| asetukset | asetukset-privacy-back | Tietosuoja → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2227 | 6 | [png](all/sheet-asetukset-privacy-back.png) |
| asetukset | asetukset-close | Asetukset sheet → Koti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-close.png) |
| chat | chat-open | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 4247 | 53 | [png](all/sheet-chat-open.png) |
| chat | chat-focus | Avustaja → Avustaja (keyboard) | swap | yes | PASS | PASS | PASS | PASS | 3731 | 23 | [png](all/sheet-chat-focus.png) |
| chat | chat-send | Avustaja → Avustaja (answer) | load | yes | n/a | PASS | FAIL | PASS | 4469 | 0 | [png](all/sheet-chat-send.png) |
| chat | chat-close | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3636 | 137 | [png](all/sheet-chat-close.png) |
| lasku | lasku-new | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | PASS | 4144 | 36 | [png](all/sheet-lasku-new.png) |
| lasku | lasku-customer-picker | Uusi lasku → asiakasvalinta | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-customer-picker.png) |
| lasku | lasku-customer-cancel | asiakasvalinta → Uusi lasku | nav | yes | PASS | PASS | PASS | PASS | 2256 | 11 | [png](all/sheet-lasku-customer-cancel.png) |
| lasku | lasku-form-scroll | Uusi lasku → Uusi lasku | scroll | yes | PASS | PASS | n/a | PASS | 1985 | 41 | [png](all/sheet-lasku-form-scroll.png) |
| lasku | lasku-cancel | Uusi lasku → Myynti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-cancel.png) |
| lasku | lasku-open | Myynti → Lasku | nav | yes | PASS | PASS | PASS | FAIL | 4436 | 13 | [png](all/sheet-lasku-open.png) |
| lasku | lasku-copy | Lasku → Uusi lasku (copy) | sheet | yes | PASS | PASS | PASS | PASS | 2932 | 17 | [png](all/sheet-lasku-copy.png) |
| lasku | lasku-copy-cancel | Uusi lasku (copy) → Lasku | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-copy-cancel.png) |
| lasku | lasku-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 2716 | 27 | [png](all/sheet-lasku-back.png) |
| pankki | pankki-kirjanpito-tab | Koti → tab Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 3109 | 5 | [png](all/sheet-pankki-kirjanpito-tab.png) |
| pankki | pankki-hub-open | Kirjanpito → Pankki | nav | yes | PASS | PASS | PASS | PASS | 3339 | 28 | [png](all/sheet-pankki-hub-open.png) |
| pankki | pankki-feed-open | Pankki → Pankkitapahtumat | nav | yes | PASS | PASS | PASS | PASS | 4624 | 25 | [png](all/sheet-pankki-feed-open.png) |
| pankki | pankki-feed-scroll | Pankkitapahtumat → Pankkitapahtumat | scroll | yes | PASS | PASS | n/a | PASS | 1918 | 39 | [png](all/sheet-pankki-feed-scroll.png) |
| pankki | pankki-feed-more | Pankkitapahtumat → Pankkitapahtumat (more) | load | yes | n/a | PASS | PASS | PASS | 3915 | 0 | [png](all/sheet-pankki-feed-more.png) |
| pankki | pankki-feed-back | Pankkitapahtumat → Pankki | nav | yes | PASS | PASS | PASS | PASS | 2228 | 27 | [png](all/sheet-pankki-feed-back.png) |
| pankki | pankki-accounts-open | Pankki → Pankkiyhteys ja tilit | nav | yes | PASS | PASS | PASS | PASS | 2916 | 17 | [png](all/sheet-pankki-accounts-open.png) |
| pankki | pankki-accounts-back | Pankkiyhteys ja tilit → Pankki | nav | yes | PASS | PASS | PASS | PASS | 2439 | 15 | [png](all/sheet-pankki-accounts-back.png) |
| pankki | pankki-hub-back | Pankki → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2081 | 6 | [png](all/sheet-pankki-hub-back.png) |
| pankki | kirjanpito-email-open | Kirjanpito → Sähköposti | nav | yes | PASS | PASS | PASS | PASS | 3839 | 18 | [png](all/sheet-kirjanpito-email-open.png) |
| pankki | kirjanpito-email-back | Sähköposti → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1973 | 41 | [png](all/sheet-kirjanpito-email-back.png) |
| pankki | kirjanpito-purchases-open | Kirjanpito → Ostolaskut | nav | yes | PASS | PASS | FAIL | FAIL | 2763 | 10 | [png](all/sheet-kirjanpito-purchases-open.png) |
| pankki | kirjanpito-purchases-back | Ostolaskut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1985 | 32 | [png](all/sheet-kirjanpito-purchases-back.png) |
| pankki | kirjanpito-match-open | Kirjanpito → Kohdista ostolaskujen maksut | nav | yes | PASS | PASS | PASS | PASS | 4357 | 1 | [png](all/sheet-kirjanpito-match-open.png) |
| pankki | kirjanpito-match-back | Kohdista ostolaskujen maksut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1894 | 35 | [png](all/sheet-kirjanpito-match-back.png) |
| pankki | kirjanpito-periods-open | Kirjanpito → Kuukauden sulku | nav | yes | PASS | PASS | PASS | PASS | 3005 | 31 | [png](all/sheet-kirjanpito-periods-open.png) |
| pankki | kirjanpito-periods-back | Kuukauden sulku → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1677 | 13 | [png](all/sheet-kirjanpito-periods-back.png) |
| pankki | kirjanpito-alv-open | Kirjanpito → ALV-ilmoitus | nav | yes | PASS | PASS | PASS | PASS | 2611 | 19 | [png](all/sheet-kirjanpito-alv-open.png) |
| pankki | kirjanpito-alv-back | ALV-ilmoitus → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2124 | 50 | [png](all/sheet-kirjanpito-alv-back.png) |
| pankki | kirjanpito-ledger-open | Kirjanpito → Kirjanpito, Tuloslaskelma | nav | yes | PASS | PASS | PASS | PASS | 3565 | 0 | [png](all/sheet-kirjanpito-ledger-open.png) |
| pankki | kirjanpito-ledger-back | Kirjanpito, Tuloslaskelma → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1862 | 37 | [png](all/sheet-kirjanpito-ledger-back.png) |
| offline | offline-tab-myynti | Koti → tab Myynti (offline) | nav | yes | PASS | PASS | PASS | FAIL | 3747 | 33 | [png](all/sheet-offline-tab-myynti.png) |
| offline | offline-refresh | Myynti → Myynti (offline error) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-offline-refresh.png) |
| offline | online-again | Myynti (offline) → Myynti | load | yes | n/a | PASS | PASS | PASS | 1170 | 0 | [png](all/sheet-online-again.png) |

## Details of FAIL rows

- **koti/koti-prev-month** (Koti → Koti (previous month)): late change [{'t': 3.84, 'area': 0.019, 'dy_pt': 0, 'what': 'pop'}, {'t': 3.94, 'area': 0.038, 'dy_pt': 0, 'what': 'pop'}, {'t': 4.07, 'area': 0.046, 'dy_pt': 0, 'what': 'pop'}, {'t': 4.17, 'area': 0.029, 'dy_pt': 0, 'what': 'pop'}]
- **koti/koti-add-sheet** (Koti → Lisää sheet): late change [{'t': 1.81, 'area': 0.021, 'dy_pt': 0, 'what': 'pop'}, {'t': 1.9, 'area': 0.679, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.02, 'area': 0.081, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.03, 'area': 0.084, 'dy_pt': -31, 'what': 'move'}, {'t': 2.09, 'area': 0.033, 'dy_pt': -9, 'what': 'move'}, {'t': 2.14, 'area': 0.021, 'dy_pt': -4, 'what': 'move'}, {'t': 2.28, 'area': 0.032, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-tab-revisit-koti** (Myynti → tab Koti): late change [{'t': 1.86, 'area': 0.137, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.03, 'area': 0.019, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-recurring-open** (Myynti → Toistuvat laskut): intermediate screens [{'frame': 4, 't': 2.66, 'held_s': 0.52, 'd_start': 11.0, 'd_end': 11.4}]
- **myynti/myynti-filter-late** (Myynti → Laskut (myöhässä)): intermediate screens [{'frame': 4, 't': 2.32, 'held_s': 0.25, 'd_start': 9.5, 'd_end': 18.0}]; late change [{'t': 3.45, 'area': 0.023, 'dy_pt': 0, 'what': 'pop'}]; probe ['MOVE 1792065071.638 invoice("3f83cd83-3cb6-4dc7-8fb1-4c8f4a6067ef") n=5 max=7 HostedViewWrapper@170,73,62x20:-7,0 _UINavigationBarTitleControl@170,73,62x20:-7,0 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@170,73,62x20:-7,0', 'MOVE 1792065072.351 invoice("3f83cd83-3cb6-4dc7-8fb1-4c8f4a6067ef") n=9 max=47 _SwiftUILayerDelegate@134,344,38x14:-47,0 _SwiftUILayerDelegate@144,321,18x18:-47,0 _SwiftUILayerDelegate@130,271,180x20:-42,0']
- **raportit/raportit-prev-year** (Raportit → Raportit (previous year)): probe ['MOVE 1792065244.265 tab.raportit n=19 max=319 ListCollectionViewCell@16,681,370x52:0,319 _UISystemBackgroundView@16,681,370x52:0,319 UIView@16,681,370x52:0,319']
- **raportit/raportit-drill-open** (Raportit → drill-down): late change [{'t': 2.91, 'area': 0.046, 'dy_pt': 0, 'what': 'pop'}, {'t': 3.11, 'area': 0.037, 'dy_pt': 0, 'what': 'pop'}, {'t': 3.28, 'area': 0.052, 'dy_pt': 0, 'what': 'pop'}]
- **asetukset/asetukset-passkeys-open** (Asetukset → Pääsyavaimet): late change [{'t': 5.24, 'area': 0.017, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-send** (Avustaja → Avustaja (answer)): intermediate screens [{'frame': 111, 't': 4.47, 'held_s': 2.45, 'd_start': 9.3, 'd_end': 12.0}]; late change [{'t': 6.99, 'area': 0.083, 'dy_pt': 0, 'what': 'pop'}]
- **lasku/lasku-open** (Myynti → Lasku): probe ['MOVE 1792065889.737 invoice("5814959c-24ae-41d6-a9c6-af8df58e35c4") n=5 max=7 HostedViewWrapper@169,73,62x20:-7,0 _UINavigationBarTitleControl@169,73,62x20:-7,0 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@169,73,62x20:-7,0']
- **pankki/kirjanpito-purchases-open** (Kirjanpito → Ostolaskut): late change [{'t': 4.01, 'area': 0.052, 'dy_pt': 0, 'what': 'pop'}]; probe ['MOVE 1792066126.074 purchaseInvoices n=13 max=85 HostedViewWrapper@72,73,86x20:-85,0 _UINavigationBarTitleControl@72,73,86x20:-85,0 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@72,73,86x20:-85,0']
- **offline/offline-tab-myynti** (Koti → tab Myynti (offline)): probe ['MOVE 1792066274.253 tab.myynti n=3 max=7 _SwiftUILayerDelegate@94,73,18x14:0,7 _SwiftUILayerDelegate@120,72,187x15:0,7 _SwiftUILayerDelegate@80,64,242x32:0,7']
