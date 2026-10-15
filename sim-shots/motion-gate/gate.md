baseline: intermediate 1, flash 0, shift_video 12, shift_probe 13, crashed 0, steps 94
pr-run1: intermediate 5, flash 0, shift_video 7, shift_probe 2, crashed 0, steps 94
pr-run2: intermediate 1, flash 0, shift_video 8, shift_probe 0, crashed 0, steps 94

NEW FAIL (PASS in baseline, FAIL in both PR runs): 0
FIXED (FAIL in baseline, PASS in both PR runs): 17

| suite | step | check | baseline | pr-run1 | pr-run2 | gate |
|---|---|---|---|---|---|---|
| asetukset | asetukset-notifications-back | shift_video | FAIL | PASS | PASS | fixed |
| asetukset | asetukset-password-back | shift_video | PASS | FAIL | PASS |  |
| asetukset | asetukset-templates-open | shift_video | FAIL | PASS | PASS | fixed |
| chat | chat-close | intermediate | PASS | PASS | FAIL |  |
| chat | chat-focus | shift_video | PASS | FAIL | PASS |  |
| chat | chat-send | shift_video | FAIL | PASS | FAIL |  |
| koti | koti-add-sheet | shift_video | FAIL | FAIL | PASS |  |
| koti | koti-next-month | shift_video | PASS | PASS | FAIL |  |
| koti | koti-prev-month | shift_probe | FAIL | PASS | PASS | fixed |
| koti | koti-prev-month | shift_video | FAIL | PASS | FAIL |  |
| koti | koti-refresh | shift_probe | FAIL | FAIL | PASS |  |
| koti | koti-refresh | shift_video | FAIL | FAIL | FAIL |  |
| lasku | lasku-open | intermediate | PASS | FAIL | PASS |  |
| lasku | lasku-open | shift_probe | FAIL | PASS | PASS | fixed |
| lasku | lasku-open | shift_video | FAIL | PASS | PASS | fixed |
| myynti | myynti-filter-late | intermediate | PASS | FAIL | PASS |  |
| myynti | myynti-filter-late | shift_probe | FAIL | PASS | PASS | fixed |
| myynti | myynti-new-invoice | shift_probe | FAIL | PASS | PASS | fixed |
| myynti | myynti-new-invoice | shift_video | FAIL | PASS | FAIL |  |
| myynti | myynti-recurring-open | intermediate | PASS | FAIL | PASS |  |
| myynti | myynti-recurring-open | shift_video | PASS | FAIL | PASS |  |
| myynti | myynti-tab | intermediate | PASS | FAIL | PASS |  |
| myynti | myynti-tab | shift_video | FAIL | FAIL | FAIL |  |
| offline | offline-tab-myynti | shift_probe | FAIL | PASS | PASS | fixed |
| offline | offline-tab-myynti | shift_video | PASS | FAIL | PASS |  |
| pankki | kirjanpito-alv-open | intermediate | FAIL | PASS | PASS | fixed |
| pankki | kirjanpito-periods-open | shift_probe | FAIL | PASS | PASS | fixed |
| pankki | kirjanpito-purchases-open | intermediate | PASS | FAIL | PASS |  |
| pankki | kirjanpito-purchases-open | shift_probe | FAIL | PASS | PASS | fixed |
| pankki | kirjanpito-purchases-open | shift_video | FAIL | PASS | PASS | fixed |
| pankki | pankki-feed-open | shift_probe | FAIL | PASS | PASS | fixed |
| pankki | pankki-kirjanpito-tab | shift_video | PASS | PASS | FAIL |  |
| raportit | raportit-drill-open | shift_probe | FAIL | PASS | PASS | fixed |
| raportit | raportit-drill-open | shift_video | FAIL | PASS | FAIL |  |
| raportit | raportit-prev-year | shift_probe | FAIL | FAIL | PASS |  |
| raportit | raportit-refresh | shift_probe | FAIL | PASS | PASS | fixed |
| raportit | raportit-refresh | shift_video | FAIL | PASS | PASS | fixed |
| raportit | raportit-tab | shift_probe | FAIL | PASS | PASS | fixed |
