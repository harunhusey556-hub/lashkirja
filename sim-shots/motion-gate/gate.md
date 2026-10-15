baseline: intermediate 2, flash 0, shift_video 8, shift_probe 5, crashed 0, steps 94
pr-run1: intermediate 5, flash 0, shift_video 10, shift_probe 4, crashed 0, steps 94
pr-run2: intermediate 1, flash 0, shift_video 5, shift_probe 1, crashed 0, steps 94

NEW FAIL (PASS in baseline, FAIL in both PR runs): 1
FIXED (FAIL in baseline, PASS in both PR runs): 7

| suite | step | check | baseline | pr-run1 | pr-run2 | gate |
|---|---|---|---|---|---|---|
| asetukset | asetukset-passkeys-open | shift_video | FAIL | PASS | PASS | fixed |
| chat | chat-close | intermediate | PASS | FAIL | PASS |  |
| chat | chat-close | shift_video | PASS | FAIL | PASS |  |
| chat | chat-open | shift_video | PASS | PASS | FAIL |  |
| chat | chat-send | shift_video | FAIL | FAIL | FAIL |  |
| koti | koti-add-sheet | shift_video | FAIL | FAIL | FAIL |  |
| koti | koti-prev-month | shift_video | FAIL | PASS | PASS | fixed |
| koti | koti-refresh | shift_probe | PASS | FAIL | PASS |  |
| lasku | lasku-open | intermediate | PASS | FAIL | FAIL | NEW FAIL |
| lasku | lasku-open | shift_probe | FAIL | PASS | PASS | fixed |
| myynti | myynti-filter-late | intermediate | FAIL | FAIL | PASS |  |
| myynti | myynti-filter-late | shift_probe | FAIL | PASS | PASS | fixed |
| myynti | myynti-filter-late | shift_video | FAIL | PASS | FAIL |  |
| myynti | myynti-new-invoice | shift_probe | PASS | FAIL | PASS |  |
| myynti | myynti-recurring-open | intermediate | FAIL | FAIL | PASS |  |
| myynti | myynti-recurring-open | shift_video | PASS | FAIL | PASS |  |
| myynti | myynti-tab-revisit-koti | shift_video | FAIL | PASS | PASS | fixed |
| offline | offline-tab-myynti | shift_probe | FAIL | PASS | FAIL |  |
| pankki | kirjanpito-email-back | shift_video | PASS | FAIL | PASS |  |
| pankki | kirjanpito-match-open | intermediate | PASS | FAIL | PASS |  |
| pankki | kirjanpito-match-open | shift_video | PASS | FAIL | PASS |  |
| pankki | kirjanpito-purchases-open | shift_probe | FAIL | PASS | PASS | fixed |
| pankki | kirjanpito-purchases-open | shift_video | FAIL | PASS | PASS | fixed |
| pankki | pankki-accounts-back | shift_video | PASS | FAIL | PASS |  |
| pankki | pankki-feed-open | shift_probe | PASS | FAIL | PASS |  |
| pankki | pankki-hub-back | shift_video | PASS | FAIL | PASS |  |
| raportit | raportit-drill-open | shift_video | FAIL | FAIL | FAIL |  |
| raportit | raportit-prev-year | shift_probe | FAIL | FAIL | PASS |  |
| raportit | raportit-prev-year | shift_video | PASS | FAIL | PASS |  |
