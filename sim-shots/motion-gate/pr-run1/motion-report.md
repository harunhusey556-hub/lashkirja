# Motion audit

99 steps. FAIL: intermediate 7, flash 0, shift (video) 20, shift (probe) 4; crashes 0.

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
| calibration | good-tab-kirjanpito | Koti → tab Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1936 | 7 | [png](all/sheet-good-tab-kirjanpito.png) |
| calibration | good-push-periods | Kirjanpito → Kuukauden sulku | nav | yes | FAIL | PASS | FAIL | PASS | 2620 | 23 | [png](all/sheet-good-push-periods.png) |
| calibration | good-swipeback-periods | Kuukauden sulku → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2211 | 39 | [png](all/sheet-good-swipeback-periods.png) |
| calibration | bad-link-over-sheet | Asetukset sheet on Koti → Lasku (Myynti) | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-bad-link-over-sheet.png) |
| calibration | bad-capture-upload | Uusi kuitti → Uusi kuitti (read) | load | yes | n/a | PASS | FAIL | FAIL | 2063 | 6 | [png](all/sheet-bad-capture-upload.png) |
| koti | koti-from-myynti-setup | launch → tab Koti | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-koti-from-myynti-setup.png) |
| koti | koti-refresh | Koti → Koti | load | yes | n/a | PASS | PASS | PASS | 2986 | 107 | [png](all/sheet-koti-refresh.png) |
| koti | koti-prev-month | Koti → Koti (previous month) | swap | yes | PASS | PASS | PASS | PASS | 3541 | 24 | [png](all/sheet-koti-prev-month.png) |
| koti | koti-next-month | Koti (previous month) → Koti | swap | yes | PASS | PASS | PASS | PASS | 3149 | 28 | [png](all/sheet-koti-next-month.png) |
| koti | koti-scroll | Koti → Koti | scroll | yes | PASS | PASS | n/a | PASS | 2556 | 91 | [png](all/sheet-koti-scroll.png) |
| koti | koti-settings-sheet | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 3126 | 57 | [png](all/sheet-koti-settings-sheet.png) |
| koti | koti-settings-close | Asetukset sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3769 | 51 | [png](all/sheet-koti-settings-close.png) |
| koti | koti-assistant-sheet | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 2741 | 53 | [png](all/sheet-koti-assistant-sheet.png) |
| koti | koti-assistant-swipedown | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3105 | 133 | [png](all/sheet-koti-assistant-swipedown.png) |
| koti | koti-add-sheet | Koti → Lisää sheet | sheet | yes | PASS | PASS | PASS | PASS | 2472 | 27 | [png](all/sheet-koti-add-sheet.png) |
| koti | koti-add-close | Lisää sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 1516 | 11 | [png](all/sheet-koti-add-close.png) |
| myynti | myynti-tab | Koti → tab Myynti | nav | yes | PASS | PASS | FAIL | PASS | 1460 | 4 | [png](all/sheet-myynti-tab.png) |
| myynti | myynti-tab-revisit-koti | Myynti → tab Koti | nav | yes | PASS | PASS | PASS | PASS | 1407 | 5 | [png](all/sheet-myynti-tab-revisit-koti.png) |
| myynti | myynti-tab-revisit | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 1448 | 10 | [png](all/sheet-myynti-tab-revisit.png) |
| myynti | myynti-refresh | Myynti → Myynti | load | yes | n/a | PASS | FAIL | PASS | 2181 | 61 | [png](all/sheet-myynti-refresh.png) |
| myynti | myynti-customers-open | Myynti → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 3262 | 47 | [png](all/sheet-myynti-customers-open.png) |
| myynti | myynti-customer-open | Asiakkaat → Asiakas | nav | yes | PASS | PASS | PASS | FAIL | 2100 | 23 | [png](all/sheet-myynti-customer-open.png) |
| myynti | myynti-customer-back | Asiakas → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 2038 | 21 | [png](all/sheet-myynti-customer-back.png) |
| myynti | myynti-customers-swipeback | Asiakkaat → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1908 | 25 | [png](all/sheet-myynti-customers-swipeback.png) |
| myynti | myynti-recurring-open | Myynti → Toistuvat laskut | nav | yes | FAIL | PASS | FAIL | PASS | 2703 | 15 | [png](all/sheet-myynti-recurring-open.png) |
| myynti | myynti-recurring-swipeback | Toistuvat laskut → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1746 | 32 | [png](all/sheet-myynti-recurring-swipeback.png) |
| myynti | myynti-filter-late | Myynti → Laskut (myöhässä) | swap | yes | FAIL | PASS | FAIL | PASS | 2680 | 41 | [png](all/sheet-myynti-filter-late.png) |
| myynti | myynti-invoice-open | Myynti → Lasku | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-invoice-open.png) |
| myynti | myynti-invoice-scroll | Lasku → Lasku | scroll | yes | PASS | PASS | n/a | PASS | 1695 | 48 | [png](all/sheet-myynti-invoice-scroll.png) |
| myynti | myynti-invoice-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1904 | 23 | [png](all/sheet-myynti-invoice-back.png) |
| myynti | myynti-new-invoice | Myynti → Uusi lasku | sheet | yes | PASS | PASS | FAIL | PASS | 4086 | 22 | [png](all/sheet-myynti-new-invoice.png) |
| myynti | myynti-new-invoice-cancel | Uusi lasku → Myynti | sheet | yes | PASS | PASS | PASS | PASS | 3882 | 48 | [png](all/sheet-myynti-new-invoice-cancel.png) |
| myynti | myynti-list-scroll | Myynti → Myynti | scroll | yes | PASS | PASS | n/a | PASS | 1639 | 37 | [png](all/sheet-myynti-list-scroll.png) |
| raportit | raportit-tab | Koti → tab Raportit | nav | yes | PASS | PASS | FAIL | PASS | 1768 | 7 | [png](all/sheet-raportit-tab.png) |
| raportit | raportit-prev-year | Raportit → Raportit (previous year) | swap | yes | PASS | PASS | PASS | PASS | 4387 | 21 | [png](all/sheet-raportit-prev-year.png) |
| raportit | raportit-next-year | Raportit (previous year) → Raportit | swap | yes | PASS | PASS | PASS | PASS | 3783 | 14 | [png](all/sheet-raportit-next-year.png) |
| raportit | raportit-refresh | Raportit → Raportit | load | yes | n/a | PASS | PASS | PASS | 4049 | 156 | [png](all/sheet-raportit-refresh.png) |
| raportit | raportit-drill-open | Raportit → drill-down | nav | yes | PASS | PASS | FAIL | PASS | 1443 | 6 | [png](all/sheet-raportit-drill-open.png) |
| raportit | raportit-drill-swipeback | drill-down → Raportit | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-raportit-drill-swipeback.png) |
| raportit | raportit-scroll | Raportit → Raportit | scroll | yes | FAIL | PASS | n/a | PASS | 1622 | 46 | [png](all/sheet-raportit-scroll.png) |
| asetukset | asetukset-open | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 3584 | 30 | [png](all/sheet-asetukset-open.png) |
| asetukset | asetukset-seller-open | Asetukset → Laskuttajan tiedot | nav | yes | PASS | PASS | PASS | PASS | 3417 | 31 | [png](all/sheet-asetukset-seller-open.png) |
| asetukset | asetukset-seller-back | Laskuttajan tiedot → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2683 | 21 | [png](all/sheet-asetukset-seller-back.png) |
| asetukset | asetukset-templates-open | Asetukset → Sähköpostimallit | nav | yes | PASS | PASS | PASS | PASS | 2682 | 19 | [png](all/sheet-asetukset-templates-open.png) |
| asetukset | asetukset-templates-back | Sähköpostimallit → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1945 | 25 | [png](all/sheet-asetukset-templates-back.png) |
| asetukset | asetukset-payments-open | Asetukset → Maksut | nav | yes | PASS | PASS | PASS | PASS | 3272 | 61 | [png](all/sheet-asetukset-payments-open.png) |
| asetukset | asetukset-payments-back | Maksut → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1944 | 22 | [png](all/sheet-asetukset-payments-back.png) |
| asetukset | asetukset-password-open | Asetukset → Vaihda salasana | nav | yes | PASS | PASS | PASS | PASS | 2754 | 18 | [png](all/sheet-asetukset-password-open.png) |
| asetukset | asetukset-password-back | Vaihda salasana → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2018 | 23 | [png](all/sheet-asetukset-password-back.png) |
| asetukset | asetukset-passkeys-open | Asetukset → Pääsyavaimet | nav | yes | PASS | PASS | PASS | PASS | 2814 | 19 | [png](all/sheet-asetukset-passkeys-open.png) |
| asetukset | asetukset-passkeys-back | Pääsyavaimet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1846 | 24 | [png](all/sheet-asetukset-passkeys-back.png) |
| asetukset | asetukset-devices-open | Asetukset → Laitteet | nav | yes | PASS | PASS | FAIL | PASS | 2827 | 15 | [png](all/sheet-asetukset-devices-open.png) |
| asetukset | asetukset-devices-back | Laitteet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2119 | 31 | [png](all/sheet-asetukset-devices-back.png) |
| asetukset | asetukset-lock-open | Asetukset → Sovelluslukitus | nav | yes | PASS | PASS | PASS | PASS | 2845 | 23 | [png](all/sheet-asetukset-lock-open.png) |
| asetukset | asetukset-lock-back | Sovelluslukitus → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1953 | 23 | [png](all/sheet-asetukset-lock-back.png) |
| asetukset | asetukset-notifications-open | Asetukset → Ilmoitukset | nav | yes | PASS | PASS | PASS | PASS | 3564 | 41 | [png](all/sheet-asetukset-notifications-open.png) |
| asetukset | asetukset-notifications-back | Ilmoitukset → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1990 | 23 | [png](all/sheet-asetukset-notifications-back.png) |
| asetukset | asetukset-privacy-open | Asetukset → Tietosuoja | nav | yes | PASS | PASS | PASS | PASS | 3496 | 46 | [png](all/sheet-asetukset-privacy-open.png) |
| asetukset | asetukset-privacy-back | Tietosuoja → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1974 | 27 | [png](all/sheet-asetukset-privacy-back.png) |
| asetukset | asetukset-help-open | Asetukset → Ohje | nav | yes | PASS | PASS | PASS | PASS | 3353 | 43 | [png](all/sheet-asetukset-help-open.png) |
| asetukset | asetukset-help-back | Ohje → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2093 | 28 | [png](all/sheet-asetukset-help-back.png) |
| asetukset | asetukset-report-open | Asetukset → Ilmoita ongelmasta | nav | yes | PASS | PASS | PASS | PASS | 2765 | 22 | [png](all/sheet-asetukset-report-open.png) |
| asetukset | asetukset-report-back | Ilmoita ongelmasta → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1939 | 21 | [png](all/sheet-asetukset-report-back.png) |
| asetukset | asetukset-close | Asetukset sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3775 | 53 | [png](all/sheet-asetukset-close.png) |
| chat | chat-open | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 3087 | 57 | [png](all/sheet-chat-open.png) |
| chat | chat-focus | Avustaja → Avustaja (keyboard) | swap | yes | PASS | PASS | FAIL | PASS | 2755 | 33 | [png](all/sheet-chat-focus.png) |
| chat | chat-send | Avustaja → Avustaja (answer) | load | yes | n/a | PASS | FAIL | PASS | 2705 | 0 | [png](all/sheet-chat-send.png) |
| chat | chat-close | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3804 | 96 | [png](all/sheet-chat-close.png) |
| lasku | lasku-new | Myynti → Uusi lasku | sheet | yes | PASS | PASS | FAIL | PASS | 4311 | 26 | [png](all/sheet-lasku-new.png) |
| lasku | lasku-form-scroll | Uusi lasku → Uusi lasku | scroll | yes | PASS | PASS | n/a | PASS | 1857 | 49 | [png](all/sheet-lasku-form-scroll.png) |
| lasku | lasku-cancel | Uusi lasku → Myynti | sheet | yes | PASS | PASS | PASS | PASS | 3805 | 44 | [png](all/sheet-lasku-cancel.png) |
| lasku | lasku-open | Myynti → Lasku | nav | yes | FAIL | PASS | FAIL | PASS | 2546 | 21 | [png](all/sheet-lasku-open.png) |
| lasku | lasku-copy | Lasku → Uusi lasku (copy) | sheet | yes | PASS | PASS | PASS | PASS | 1979 | 9 | [png](all/sheet-lasku-copy.png) |
| lasku | lasku-copy-cancel | Uusi lasku (copy) → Lasku | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-copy-cancel.png) |
| lasku | lasku-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1969 | 26 | [png](all/sheet-lasku-back.png) |
| pankki | pankki-kirjanpito-tab | Koti → tab Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1747 | 6 | [png](all/sheet-pankki-kirjanpito-tab.png) |
| pankki | pankki-hub-open | Kirjanpito → Pankki | nav | yes | PASS | PASS | FAIL | PASS | 2594 | 16 | [png](all/sheet-pankki-hub-open.png) |
| pankki | pankki-feed-open | Pankki → Pankkitapahtumat | nav | yes | PASS | PASS | FAIL | PASS | 2921 | 17 | [png](all/sheet-pankki-feed-open.png) |
| pankki | pankki-feed-scroll | Pankkitapahtumat → Pankkitapahtumat | scroll | yes | PASS | PASS | n/a | PASS | 1679 | 42 | [png](all/sheet-pankki-feed-scroll.png) |
| pankki | pankki-feed-more | Pankkitapahtumat → Pankkitapahtumat (more) | load | yes | n/a | PASS | PASS | PASS | 2384 | 6 | [png](all/sheet-pankki-feed-more.png) |
| pankki | pankki-feed-back | Pankkitapahtumat → Pankki | nav | yes | PASS | PASS | PASS | PASS | 2219 | 32 | [png](all/sheet-pankki-feed-back.png) |
| pankki | pankki-accounts-open | Pankki → Pankkiyhteys ja tilit | nav | yes | PASS | PASS | PASS | PASS | 3556 | 78 | [png](all/sheet-pankki-accounts-open.png) |
| pankki | pankki-accounts-back | Pankkiyhteys ja tilit → Pankki | nav | yes | PASS | PASS | PASS | PASS | 2014 | 25 | [png](all/sheet-pankki-accounts-back.png) |
| pankki | pankki-hub-back | Pankki → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1962 | 26 | [png](all/sheet-pankki-hub-back.png) |
| pankki | kirjanpito-email-open | Kirjanpito → Sähköposti | nav | yes | PASS | PASS | PASS | PASS | 2455 | 29 | [png](all/sheet-kirjanpito-email-open.png) |
| pankki | kirjanpito-email-back | Sähköposti → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2138 | 45 | [png](all/sheet-kirjanpito-email-back.png) |
| pankki | kirjanpito-purchases-open | Kirjanpito → Ostolaskut | nav | yes | PASS | PASS | PASS | FAIL | 3555 | 84 | [png](all/sheet-kirjanpito-purchases-open.png) |
| pankki | kirjanpito-purchases-back | Ostolaskut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1898 | 34 | [png](all/sheet-kirjanpito-purchases-back.png) |
| pankki | kirjanpito-match-open | Kirjanpito → Kohdista ostolaskujen maksut | nav | yes | PASS | PASS | PASS | PASS | 3137 | 64 | [png](all/sheet-kirjanpito-match-open.png) |
| pankki | kirjanpito-match-back | Kohdista ostolaskujen maksut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2258 | 41 | [png](all/sheet-kirjanpito-match-back.png) |
| pankki | kirjanpito-periods-open | Kirjanpito → Kuukauden sulku | nav | yes | PASS | PASS | FAIL | PASS | 2706 | 18 | [png](all/sheet-kirjanpito-periods-open.png) |
| pankki | kirjanpito-periods-back | Kuukauden sulku → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2246 | 51 | [png](all/sheet-kirjanpito-periods-back.png) |
| pankki | kirjanpito-alv-open | Kirjanpito → ALV-ilmoitus | nav | yes | FAIL | PASS | FAIL | PASS | 2780 | 21 | [png](all/sheet-kirjanpito-alv-open.png) |
| pankki | kirjanpito-alv-back | ALV-ilmoitus → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2541 | 42 | [png](all/sheet-kirjanpito-alv-back.png) |
| pankki | kirjanpito-ledger-open | Kirjanpito → Kirjanpito, Tuloslaskelma | nav | yes | PASS | PASS | PASS | PASS | 2601 | 18 | [png](all/sheet-kirjanpito-ledger-open.png) |
| pankki | kirjanpito-ledger-back | Kirjanpito, Tuloslaskelma → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1999 | 43 | [png](all/sheet-kirjanpito-ledger-back.png) |
| offline | offline-tab-myynti | Koti → tab Myynti (offline) | nav | yes | FAIL | PASS | FAIL | PASS | 1697 | 5 | [png](all/sheet-offline-tab-myynti.png) |
| offline | offline-refresh | Myynti → Myynti (offline error) | load | yes | n/a | PASS | FAIL | FAIL | 1740 | 28 | [png](all/sheet-offline-refresh.png) |
| offline | online-again | Myynti (offline) → Myynti | load | yes | n/a | PASS | PASS | PASS | 3885 | 143 | [png](all/sheet-online-again.png) |

## Details of FAIL rows

- **calibration/good-push-periods** (Kirjanpito → Kuukauden sulku): intermediate screens [{'frame': 5, 't': 2.62, 'held_s': 1.28, 'd_start': 9.5, 'd_end': 10.1}, {'frame': 22, 't': 3.9, 'held_s': 1.52, 'd_start': 10.0, 'd_end': 9.7}]; late change [{'t': 5.42, 'area': 0.088, 'dy_pt': 0, 'what': 'pop'}]
- **calibration/bad-capture-upload** (Uusi kuitti → Uusi kuitti (read)): intermediate screens [{'frame': 2, 't': 2.06, 'held_s': 9.58, 'd_start': 12.6, 'd_end': 18.0}]; late change [{'t': 11.64, 'area': 0.125, 'dy_pt': 0, 'what': 'pop'}, {'t': 12.28, 'area': 0.081, 'dy_pt': 0, 'what': 'pop'}]; probe ['MOVE 1792045186.284 receipts n=103 max=163 PlatformViewHost<PlatformViewRepresentableAdaptor<SystemSegmentedControl>>@20,408,362x31:0,163 UISegmentedControl@20,408,362x32:0,163 UIImageView@20,408,180x32:0,163']
- **myynti/myynti-tab** (Koti → tab Myynti): late change [{'t': 3.4, 'area': 0.055, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-refresh** (Myynti → Myynti): intermediate screens [{'frame': 4, 't': 1.25, 'held_s': 0.36, 'd_start': 14.3, 'd_end': 14.3}, {'frame': 8, 't': 1.71, 'held_s': 0.47, 'd_start': 14.6, 'd_end': 14.6}]; late change [{'t': 2.82, 'area': 0.132, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.96, 'area': 0.034, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-customer-open** (Asiakkaat → Asiakas): probe ['SCROLLJUMP 1792045504.812 customer("41767abf-b3cd-4695-91b8-c213d7d7ce0f") dy=52']
- **myynti/myynti-recurring-open** (Myynti → Toistuvat laskut): intermediate screens [{'frame': 5, 't': 2.7, 'held_s': 1.27, 'd_start': 11.6, 'd_end': 10.8}]; late change [{'t': 3.98, 'area': 0.057, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-filter-late** (Myynti → Laskut (myöhässä)): intermediate screens [{'frame': 5, 't': 2.22, 'held_s': 0.46, 'd_start': 9.9, 'd_end': 20.3}]; late change [{'t': 3.36, 'area': 0.074, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-new-invoice** (Myynti → Uusi lasku): late change [{'t': 4.76, 'area': 0.04, 'dy_pt': 0, 'what': 'pop'}, {'t': 4.88, 'area': 0.034, 'dy_pt': 0, 'what': 'pop'}, {'t': 5.07, 'area': 0.017, 'dy_pt': 0, 'what': 'pop'}]
- **raportit/raportit-tab** (Koti → tab Raportit): late change [{'t': 3.59, 'area': 0.048, 'dy_pt': 0, 'what': 'pop'}]
- **raportit/raportit-drill-open** (Raportit → drill-down): late change [{'t': 3.2, 'area': 0.055, 'dy_pt': 0, 'what': 'pop'}]
- **raportit/raportit-scroll** (Raportit → Raportit): intermediate screens [{'frame': 4, 't': 1.04, 'held_s': 0.25, 'd_start': 14.7, 'd_end': 13.7}]
- **asetukset/asetukset-devices-open** (Asetukset → Laitteet): late change [{'t': 3.48, 'area': 0.02, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-focus** (Avustaja → Avustaja (keyboard)): late change [{'t': 3.95, 'area': 0.02, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-send** (Avustaja → Avustaja (answer)): intermediate screens [{'frame': 32, 't': 2.71, 'held_s': 1.53, 'd_start': 9.3, 'd_end': 11.7}]; late change [{'t': 4.24, 'area': 0.074, 'dy_pt': 0, 'what': 'pop'}]
- **lasku/lasku-new** (Myynti → Uusi lasku): late change [{'t': 5.07, 'area': 0.04, 'dy_pt': 0, 'what': 'pop'}, {'t': 5.16, 'area': 0.035, 'dy_pt': 0, 'what': 'pop'}, {'t': 5.25, 'area': 0.017, 'dy_pt': 0, 'what': 'pop'}]
- **lasku/lasku-open** (Myynti → Lasku): intermediate screens [{'frame': 5, 't': 2.55, 'held_s': 1.53, 'd_start': 11.6, 'd_end': 16.4}]; late change [{'t': 4.07, 'area': 0.085, 'dy_pt': 0, 'what': 'pop'}]
- **pankki/pankki-hub-open** (Kirjanpito → Pankki): late change [{'t': 3.23, 'area': 0.072, 'dy_pt': 0, 'what': 'pop'}, {'t': 3.41, 'area': 0.031, 'dy_pt': 0, 'what': 'pop'}]
- **pankki/pankki-feed-open** (Pankki → Pankkitapahtumat): late change [{'t': 5.87, 'area': 0.085, 'dy_pt': 0, 'what': 'pop'}]
- **pankki/kirjanpito-purchases-open** (Kirjanpito → Ostolaskut): probe ['MOVE 1792046482.727 purchaseInvoices n=61 max=1833 _UICollectionViewListLayoutSectionBackgroundColorDecorationView@-20,85,442x128:0,1833 CGDrawingView@281,512,54x13:0,100 _UICollectionViewListLayoutSectionBackgroundColorDecorationView@-20,373,442x62:0,100']
- **pankki/kirjanpito-periods-open** (Kirjanpito → Kuukauden sulku): late change [{'t': 4.51, 'area': 0.074, 'dy_pt': 0, 'what': 'pop'}, {'t': 4.83, 'area': 0.124, 'dy_pt': 0, 'what': 'pop'}]
- **pankki/kirjanpito-alv-open** (Kirjanpito → ALV-ilmoitus): intermediate screens [{'frame': 6, 't': 2.78, 'held_s': 1.18, 'd_start': 9.9, 'd_end': 15.7}]; late change [{'t': 3.97, 'area': 0.096, 'dy_pt': 0, 'what': 'pop'}]
- **offline/offline-tab-myynti** (Koti → tab Myynti (offline)): intermediate screens [{'frame': 5, 't': 1.7, 'held_s': 1.74, 'd_start': 10.8, 'd_end': 9.0}]; late change [{'t': 3.44, 'area': 0.055, 'dy_pt': 0, 'what': 'pop'}]
- **offline/offline-refresh** (Myynti → Myynti (offline error)): intermediate screens [{'frame': 5, 't': 1.39, 'held_s': 0.26, 'd_start': 14.3, 'd_end': 14.0}, {'frame': 9, 't': 1.74, 'held_s': 4.88, 'd_start': 14.6, 'd_end': 14.3}, {'frame': 68, 't': 6.62, 'held_s': 0.32, 'd_start': 11.5, 'd_end': 12.3}]; late change [{'t': 6.62, 'area': 0.117, 'dy_pt': 0, 'what': 'pop'}, {'t': 6.94, 'area': 0.022, 'dy_pt': 0, 'what': 'pop'}, {'t': 7.04, 'area': 0.107, 'dy_pt': 0, 'what': 'pop'}]; probe ['MOVE 1792046634.282 tab.myynti n=99 max=1832 _UICollectionViewListLayoutSectionBackgroundColorDecorationView@-20,84,442x146:0,1832 CGDrawingView@246,512,89x13:0,90 _UICollectionViewListLayoutSectionBackgroundColorDecorationView@-20,366,442x329:0,90', 'SCROLLJUMP 1792046634.436 tab.myynti dy=59']
