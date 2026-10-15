# Motion audit

94 steps. FAIL: intermediate 5, flash 0, shift (video) 10, shift (probe) 4; crashes 0.

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
| calibration | good-tab-kirjanpito | Koti → tab Kirjanpito | nav | NO | PASS | PASS | PASS | PASS | 1888 | 20 | [png](all/sheet-good-tab-kirjanpito.png) |
| calibration | bad-link-over-sheet | Asetukset sheet on Koti → Lasku (Myynti) | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-bad-link-over-sheet.png) |
| koti | koti-from-myynti-setup | launch → tab Koti | nav | yes | PASS | PASS | PASS | PASS | 1410 | 8 | [png](all/sheet-koti-from-myynti-setup.png) |
| koti | koti-refresh | Koti → Koti | load | yes | n/a | PASS | PASS | FAIL | 3149 | 117 | [png](all/sheet-koti-refresh.png) |
| koti | koti-prev-month | Koti → Koti (previous month) | swap | yes | PASS | PASS | PASS | PASS | 3855 | 12 | [png](all/sheet-koti-prev-month.png) |
| koti | koti-next-month | Koti (previous month) → Koti | swap | yes | PASS | PASS | PASS | PASS | 3325 | 14 | [png](all/sheet-koti-next-month.png) |
| koti | koti-scroll | Koti → Koti | scroll | yes | PASS | PASS | n/a | PASS | 2611 | 87 | [png](all/sheet-koti-scroll.png) |
| koti | koti-settings-sheet | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 4197 | 18 | [png](all/sheet-koti-settings-sheet.png) |
| koti | koti-settings-close | Asetukset sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3584 | 15 | [png](all/sheet-koti-settings-close.png) |
| koti | koti-assistant-sheet | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 3549 | 16 | [png](all/sheet-koti-assistant-sheet.png) |
| koti | koti-assistant-swipedown | Avustaja → Koti | sheet | yes | PASS | PASS | PASS | PASS | 3901 | 86 | [png](all/sheet-koti-assistant-swipedown.png) |
| koti | koti-add-sheet | Koti → Lisää sheet | sheet | yes | PASS | PASS | FAIL | PASS | 1496 | 25 | [png](all/sheet-koti-add-sheet.png) |
| koti | koti-add-close | Lisää sheet → Koti | sheet | yes | PASS | PASS | PASS | PASS | 1586 | 9 | [png](all/sheet-koti-add-close.png) |
| myynti | myynti-tab | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 3424 | 45 | [png](all/sheet-myynti-tab.png) |
| myynti | myynti-tab-revisit-koti | Myynti → tab Koti | nav | yes | PASS | PASS | PASS | PASS | 1693 | 39 | [png](all/sheet-myynti-tab-revisit-koti.png) |
| myynti | myynti-tab-revisit | Koti → tab Myynti | nav | yes | PASS | PASS | PASS | PASS | 1432 | 24 | [png](all/sheet-myynti-tab-revisit.png) |
| myynti | myynti-refresh | Myynti → Myynti | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-refresh.png) |
| myynti | myynti-customers-open | Myynti → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 3313 | 24 | [png](all/sheet-myynti-customers-open.png) |
| myynti | myynti-customer-open | Asiakkaat → Asiakas | nav | yes | PASS | PASS | PASS | PASS | 2353 | 8 | [png](all/sheet-myynti-customer-open.png) |
| myynti | myynti-customer-back | Asiakas → Asiakkaat | nav | yes | PASS | PASS | PASS | PASS | 2361 | 18 | [png](all/sheet-myynti-customer-back.png) |
| myynti | myynti-customers-swipeback | Asiakkaat → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1951 | 31 | [png](all/sheet-myynti-customers-swipeback.png) |
| myynti | myynti-recurring-open | Myynti → Toistuvat laskut | nav | yes | FAIL | PASS | FAIL | PASS | 3107 | 14 | [png](all/sheet-myynti-recurring-open.png) |
| myynti | myynti-recurring-swipeback | Toistuvat laskut → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1923 | 38 | [png](all/sheet-myynti-recurring-swipeback.png) |
| myynti | myynti-filter-late | Myynti → Laskut (myöhässä) | swap | yes | FAIL | PASS | PASS | PASS | 3806 | 30 | [png](all/sheet-myynti-filter-late.png) |
| myynti | myynti-invoice-open | Myynti → Lasku | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-invoice-open.png) |
| myynti | myynti-invoice-scroll | Lasku → Lasku | scroll | yes | PASS | PASS | n/a | PASS | 1249 | 44 | [png](all/sheet-myynti-invoice-scroll.png) |
| myynti | myynti-invoice-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 1918 | 24 | [png](all/sheet-myynti-invoice-back.png) |
| myynti | myynti-new-invoice | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | FAIL | 4169 | 50 | [png](all/sheet-myynti-new-invoice.png) |
| myynti | myynti-new-invoice-cancel | Uusi lasku → Myynti | sheet | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-myynti-new-invoice-cancel.png) |
| myynti | myynti-list-scroll | Myynti → Myynti | scroll | yes | PASS | PASS | n/a | PASS | 1459 | 24 | [png](all/sheet-myynti-list-scroll.png) |
| raportit | raportit-tab | Koti → tab Raportit | nav | yes | PASS | PASS | PASS | PASS | 2292 | 16 | [png](all/sheet-raportit-tab.png) |
| raportit | raportit-prev-year | Raportit → Raportit (previous year) | swap | yes | PASS | PASS | FAIL | FAIL | 3037 | 0 | [png](all/sheet-raportit-prev-year.png) |
| raportit | raportit-next-year | Raportit (previous year) → Raportit | swap | yes | PASS | PASS | PASS | PASS | 4071 | 6 | [png](all/sheet-raportit-next-year.png) |
| raportit | raportit-refresh | Raportit → Raportit | load | yes | n/a | PASS | PASS | PASS | 2513 | 96 | [png](all/sheet-raportit-refresh.png) |
| raportit | raportit-drill-open | Raportit → drill-down | nav | yes | PASS | PASS | FAIL | PASS | 989 | 6 | [png](all/sheet-raportit-drill-open.png) |
| raportit | raportit-drill-swipeback | drill-down → Raportit | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-raportit-drill-swipeback.png) |
| raportit | raportit-scroll | Raportit → Raportit | scroll | yes | PASS | PASS | n/a | PASS | 1353 | 35 | [png](all/sheet-raportit-scroll.png) |
| asetukset | asetukset-open | Koti → Asetukset sheet | sheet | yes | PASS | PASS | PASS | PASS | 3514 | 28 | [png](all/sheet-asetukset-open.png) |
| asetukset | asetukset-seller-open | Asetukset → Laskuttajan tiedot | nav | yes | PASS | PASS | PASS | PASS | 3474 | 25 | [png](all/sheet-asetukset-seller-open.png) |
| asetukset | asetukset-seller-back | Laskuttajan tiedot → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2390 | 18 | [png](all/sheet-asetukset-seller-back.png) |
| asetukset | asetukset-templates-open | Asetukset → Sähköpostimallit | nav | yes | PASS | PASS | PASS | PASS | 2541 | 29 | [png](all/sheet-asetukset-templates-open.png) |
| asetukset | asetukset-templates-back | Sähköpostimallit → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1777 | 14 | [png](all/sheet-asetukset-templates-back.png) |
| asetukset | asetukset-payments-open | Asetukset → Maksut | nav | yes | PASS | PASS | PASS | PASS | 2073 | 19 | [png](all/sheet-asetukset-payments-open.png) |
| asetukset | asetukset-payments-back | Maksut → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1769 | 18 | [png](all/sheet-asetukset-payments-back.png) |
| asetukset | asetukset-password-open | Asetukset → Vaihda salasana | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-password-open.png) |
| asetukset | asetukset-password-back | Vaihda salasana → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2455 | 8 | [png](all/sheet-asetukset-password-back.png) |
| asetukset | asetukset-passkeys-open | Asetukset → Pääsyavaimet | nav | yes | PASS | PASS | PASS | PASS | 3539 | 18 | [png](all/sheet-asetukset-passkeys-open.png) |
| asetukset | asetukset-passkeys-back | Pääsyavaimet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1621 | 17 | [png](all/sheet-asetukset-passkeys-back.png) |
| asetukset | asetukset-devices-open | Asetukset → Laitteet | nav | yes | PASS | PASS | PASS | PASS | 2670 | 20 | [png](all/sheet-asetukset-devices-open.png) |
| asetukset | asetukset-devices-back | Laitteet → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2117 | 19 | [png](all/sheet-asetukset-devices-back.png) |
| asetukset | asetukset-lock-open | Asetukset → Sovelluslukitus | nav | yes | PASS | PASS | PASS | PASS | 3892 | 15 | [png](all/sheet-asetukset-lock-open.png) |
| asetukset | asetukset-lock-back | Sovelluslukitus → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2073 | 12 | [png](all/sheet-asetukset-lock-back.png) |
| asetukset | asetukset-notifications-open | Asetukset → Ilmoitukset | nav | yes | PASS | PASS | PASS | PASS | 3632 | 17 | [png](all/sheet-asetukset-notifications-open.png) |
| asetukset | asetukset-notifications-back | Ilmoitukset → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 1534 | 15 | [png](all/sheet-asetukset-notifications-back.png) |
| asetukset | asetukset-privacy-open | Asetukset → Tietosuoja | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-privacy-open.png) |
| asetukset | asetukset-privacy-back | Tietosuoja → Asetukset | nav | yes | PASS | PASS | PASS | PASS | 2248 | 15 | [png](all/sheet-asetukset-privacy-back.png) |
| asetukset | asetukset-close | Asetukset sheet → Koti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-asetukset-close.png) |
| chat | chat-open | Koti → Avustaja | sheet | yes | PASS | PASS | PASS | PASS | 2284 | 15 | [png](all/sheet-chat-open.png) |
| chat | chat-focus | Avustaja → Avustaja (keyboard) | swap | yes | PASS | PASS | PASS | PASS | 1951 | 15 | [png](all/sheet-chat-focus.png) |
| chat | chat-send | Avustaja → Avustaja (answer) | load | yes | n/a | PASS | FAIL | PASS | 2259 | 0 | [png](all/sheet-chat-send.png) |
| chat | chat-close | Avustaja → Koti | sheet | yes | FAIL | PASS | FAIL | PASS | 2124 | 53 | [png](all/sheet-chat-close.png) |
| lasku | lasku-new | Myynti → Uusi lasku | sheet | yes | PASS | PASS | PASS | PASS | 2985 | 25 | [png](all/sheet-lasku-new.png) |
| lasku | lasku-customer-picker | Uusi lasku → asiakasvalinta | nav | yes | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-customer-picker.png) |
| lasku | lasku-customer-cancel | asiakasvalinta → Uusi lasku | nav | yes | PASS | PASS | PASS | PASS | 1533 | 6 | [png](all/sheet-lasku-customer-cancel.png) |
| lasku | lasku-form-scroll | Uusi lasku → Uusi lasku | scroll | yes | PASS | PASS | n/a | PASS | 1408 | 31 | [png](all/sheet-lasku-form-scroll.png) |
| lasku | lasku-cancel | Uusi lasku → Myynti | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-cancel.png) |
| lasku | lasku-open | Myynti → Lasku | nav | yes | FAIL | PASS | PASS | PASS | 2414 | 23 | [png](all/sheet-lasku-open.png) |
| lasku | lasku-copy | Lasku → Uusi lasku (copy) | sheet | yes | PASS | PASS | PASS | PASS | 3268 | 9 | [png](all/sheet-lasku-copy.png) |
| lasku | lasku-copy-cancel | Uusi lasku (copy) → Lasku | sheet | NO | PASS | PASS | PASS | PASS | None | None | [png](all/sheet-lasku-copy-cancel.png) |
| lasku | lasku-back | Lasku → Myynti | nav | yes | PASS | PASS | PASS | PASS | 2512 | 15 | [png](all/sheet-lasku-back.png) |
| pankki | pankki-kirjanpito-tab | Koti → tab Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2257 | 3 | [png](all/sheet-pankki-kirjanpito-tab.png) |
| pankki | pankki-hub-open | Kirjanpito → Pankki | nav | yes | PASS | PASS | PASS | PASS | 3789 | 17 | [png](all/sheet-pankki-hub-open.png) |
| pankki | pankki-feed-open | Pankki → Pankkitapahtumat | nav | yes | PASS | PASS | PASS | FAIL | 1839 | 0 | [png](all/sheet-pankki-feed-open.png) |
| pankki | pankki-feed-scroll | Pankkitapahtumat → Pankkitapahtumat | scroll | yes | PASS | PASS | n/a | PASS | 630 | 0 | [png](all/sheet-pankki-feed-scroll.png) |
| pankki | pankki-feed-more | Pankkitapahtumat → Pankkitapahtumat (more) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-pankki-feed-more.png) |
| pankki | pankki-feed-back | Pankkitapahtumat → Pankki | nav | yes | PASS | PASS | PASS | PASS | 1852 | 34 | [png](all/sheet-pankki-feed-back.png) |
| pankki | pankki-accounts-open | Pankki → Pankkiyhteys ja tilit | nav | yes | PASS | PASS | PASS | PASS | 2961 | 0 | [png](all/sheet-pankki-accounts-open.png) |
| pankki | pankki-accounts-back | Pankkiyhteys ja tilit → Pankki | nav | yes | PASS | PASS | FAIL | PASS | 1238 | 0 | [png](all/sheet-pankki-accounts-back.png) |
| pankki | pankki-hub-back | Pankki → Kirjanpito | nav | yes | PASS | PASS | FAIL | PASS | 1839 | 6 | [png](all/sheet-pankki-hub-back.png) |
| pankki | kirjanpito-email-open | Kirjanpito → Sähköposti | nav | yes | PASS | PASS | PASS | PASS | 3445 | 0 | [png](all/sheet-kirjanpito-email-open.png) |
| pankki | kirjanpito-email-back | Sähköposti → Kirjanpito | nav | yes | PASS | PASS | FAIL | PASS | 810 | 0 | [png](all/sheet-kirjanpito-email-back.png) |
| pankki | kirjanpito-purchases-open | Kirjanpito → Ostolaskut | nav | yes | PASS | PASS | PASS | PASS | 3265 | 27 | [png](all/sheet-kirjanpito-purchases-open.png) |
| pankki | kirjanpito-purchases-back | Ostolaskut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2297 | 0 | [png](all/sheet-kirjanpito-purchases-back.png) |
| pankki | kirjanpito-match-open | Kirjanpito → Kohdista ostolaskujen maksut | nav | yes | FAIL | PASS | FAIL | PASS | 2098 | 0 | [png](all/sheet-kirjanpito-match-open.png) |
| pankki | kirjanpito-match-back | Kohdista ostolaskujen maksut → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2037 | 49 | [png](all/sheet-kirjanpito-match-back.png) |
| pankki | kirjanpito-periods-open | Kirjanpito → Kuukauden sulku | nav | yes | PASS | PASS | PASS | PASS | 2966 | 0 | [png](all/sheet-kirjanpito-periods-open.png) |
| pankki | kirjanpito-periods-back | Kuukauden sulku → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2720 | 99 | [png](all/sheet-kirjanpito-periods-back.png) |
| pankki | kirjanpito-alv-open | Kirjanpito → ALV-ilmoitus | nav | yes | PASS | PASS | PASS | PASS | 3710 | 47 | [png](all/sheet-kirjanpito-alv-open.png) |
| pankki | kirjanpito-alv-back | ALV-ilmoitus → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 2671 | 66 | [png](all/sheet-kirjanpito-alv-back.png) |
| pankki | kirjanpito-ledger-open | Kirjanpito → Kirjanpito, Tuloslaskelma | nav | yes | PASS | PASS | PASS | PASS | 2848 | 6 | [png](all/sheet-kirjanpito-ledger-open.png) |
| pankki | kirjanpito-ledger-back | Kirjanpito, Tuloslaskelma → Kirjanpito | nav | yes | PASS | PASS | PASS | PASS | 1852 | 67 | [png](all/sheet-kirjanpito-ledger-back.png) |
| offline | offline-tab-myynti | Koti → tab Myynti (offline) | nav | yes | PASS | PASS | PASS | PASS | 3620 | 35 | [png](all/sheet-offline-tab-myynti.png) |
| offline | offline-refresh | Myynti → Myynti (offline error) | load | yes | n/a | PASS | PASS | PASS | None | None | [png](all/sheet-offline-refresh.png) |
| offline | online-again | Myynti (offline) → Myynti | load | yes | n/a | PASS | PASS | PASS | 5660 | 0 | [png](all/sheet-online-again.png) |

## Details of FAIL rows

- **koti/koti-refresh** (Koti → Koti): intermediate screens [{'frame': 17, 't': 2.31, 'held_s': 0.49, 'd_start': 11.4, 'd_end': 11.4}]; probe ['MOVE 1792066901.083 tab.koti n=1 max=60 NavigationBarLargeTitleView@0,116,402x52:0,-60', 'SCROLLJUMP 1792066901.166 tab.koti dy=11', 'MOVE 1792066901.168 tab.koti n=11 max=11 _UITouchPassthroughView@0,-217,402x874:0,11 BackdropView@0,-217,402x170:0,11 BackdropView@0,509,402x147:0,11']
- **koti/koti-add-sheet** (Koti → Lisää sheet): late change [{'t': 2.24, 'area': 0.033, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.46, 'area': 0.509, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.59, 'area': 0.039, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-recurring-open** (Myynti → Toistuvat laskut): intermediate screens [{'frame': 3, 't': 3.11, 'held_s': 1.03, 'd_start': 11.0, 'd_end': 11.4}]; late change [{'t': 4.14, 'area': 0.056, 'dy_pt': 0, 'what': 'pop'}]
- **myynti/myynti-filter-late** (Myynti → Laskut (myöhässä)): intermediate screens [{'frame': 4, 't': 3.29, 'held_s': 0.52, 'd_start': 10.2, 'd_end': 18.8}]
- **myynti/myynti-new-invoice** (Myynti → Uusi lasku): probe ['MOVE 1792067248.984 tab.myynti n=3 max=25 HostedViewWrapper@135,83,132x34:-25,-6 _UINavigationBarTitleControl@135,83,132x34:-25,-6 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@135,83,132x34:-25,-6']
- **raportit/raportit-prev-year** (Raportit → Raportit (previous year)): late change [{'t': 3.98, 'area': 0.037, 'dy_pt': 0, 'what': 'pop'}]; probe ['MOVE 1792067357.290 tab.raportit n=19 max=319 ListCollectionViewCell@16,681,370x52:0,319 _UISystemBackgroundView@16,681,370x52:0,319 UIView@16,681,370x52:0,319']
- **raportit/raportit-drill-open** (Raportit → drill-down): late change [{'t': 2.01, 'area': 0.036, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.05, 'area': 0.041, 'dy_pt': 0, 'what': 'pop'}, {'t': 2.47, 'area': 0.052, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-send** (Avustaja → Avustaja (answer)): intermediate screens [{'frame': 32, 't': 2.26, 'held_s': 0.81, 'd_start': 9.1, 'd_end': 11.9}]; late change [{'t': 3.55, 'area': 0.082, 'dy_pt': 0, 'what': 'pop'}]
- **chat/chat-close** (Avustaja → Koti): intermediate screens [{'frame': 53, 't': 2.12, 'held_s': 1.22, 'd_start': 14.1, 'd_end': 11.9}]; late change [{'t': 3.34, 'area': 0.132, 'dy_pt': 0, 'what': 'pop'}]
- **lasku/lasku-open** (Myynti → Lasku): intermediate screens [{'frame': 13, 't': 2.04, 'held_s': 0.38, 'd_start': 10.7, 'd_end': 18.5}]
- **pankki/pankki-feed-open** (Pankki → Pankkitapahtumat): probe ['MOVE 1792068081.817 bankFeed n=8 max=84 AnimationView@135,59,262x48:-84,0 PlatterView@146,62,239x44:-80,0 AnimationView@146,62,239x44:-80,0']
- **pankki/pankki-accounts-back** (Pankkiyhteys ja tilit → Pankki): late change [{'t': 1.86, 'area': 0.087, 'dy_pt': 0, 'what': 'pop'}]
- **pankki/pankki-hub-back** (Pankki → Kirjanpito): late change [{'t': 2.45, 'area': 0.031, 'dy_pt': 0, 'what': 'pop'}]
- **pankki/kirjanpito-email-back** (Sähköposti → Kirjanpito): late change [{'t': 2.21, 'area': 0.109, 'dy_pt': 0, 'what': 'pop'}]
- **pankki/kirjanpito-match-open** (Kirjanpito → Kohdista ostolaskujen maksut): intermediate screens [{'frame': 3, 't': 2.1, 'held_s': 1.21, 'd_start': 9.0, 'd_end': 9.6}]; late change [{'t': 3.31, 'area': 0.068, 'dy_pt': 0, 'what': 'pop'}]
