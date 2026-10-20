baseline: intermediate 3, flash 0, shift_video 10, shift_probe 8, crashed 0, steps 94
pr-run1: intermediate 4, flash 0, shift_video 5, shift_probe 2, crashed 0, steps 94
pr-run2: intermediate 2, flash 0, shift_video 8, shift_probe 3, crashed 0, steps 94

NEW FAIL (PASS in baseline, FAIL in both PR runs): 2
FIXED (FAIL in baseline, PASS in both PR runs): 14

| suite | step | check | baseline | pr-run1 | pr-run2 | gate |
|---|---|---|---|---|---|---|
| asetukset | asetukset-devices-open | shift_video | PASS | FAIL | PASS |  |
| asetukset | asetukset-password-open | shift_video | FAIL | PASS | PASS | fixed |
| chat | chat-send | shift_video | FAIL | FAIL | FAIL |  |
| koti | koti-add-sheet | shift_video | FAIL | PASS | FAIL |  |
| koti | koti-prev-month | shift_probe | FAIL | PASS | PASS | fixed |
| koti | koti-refresh | shift_probe | FAIL | PASS | FAIL |  |
| koti | koti-scroll | intermediate | PASS | FAIL | PASS |  |
| koti | koti-settings-close | intermediate | PASS | FAIL | PASS |  |
| lasku | lasku-new | shift_probe | FAIL | FAIL | PASS |  |
| lasku | lasku-open | intermediate | FAIL | PASS | PASS | fixed |
| lasku | lasku-open | shift_probe | FAIL | PASS | PASS | fixed |
| lasku | lasku-open | shift_video | FAIL | PASS | PASS | fixed |
| myynti | myynti-customer-back | shift_video | PASS | PASS | FAIL |  |
| myynti | myynti-customers-open | shift_video | PASS | PASS | FAIL |  |
| myynti | myynti-filter-late | intermediate | FAIL | PASS | PASS | fixed |
| myynti | myynti-filter-late | shift_probe | FAIL | PASS | PASS | fixed |
| myynti | myynti-filter-late | shift_video | FAIL | PASS | PASS | fixed |
| myynti | myynti-invoice-back | shift_video | PASS | PASS | FAIL |  |
| myynti | myynti-new-invoice | shift_probe | PASS | PASS | FAIL |  |
| myynti | myynti-new-invoice | shift_video | FAIL | PASS | PASS | fixed |
| myynti | myynti-recurring-open | intermediate | PASS | FAIL | FAIL | NEW FAIL |
| myynti | myynti-recurring-open | shift_video | PASS | PASS | FAIL |  |
| myynti | myynti-tab-revisit-koti | shift_video | FAIL | PASS | FAIL |  |
| offline | offline-tab-myynti | intermediate | PASS | FAIL | FAIL | NEW FAIL |
| offline | offline-tab-myynti | shift_probe | FAIL | FAIL | FAIL |  |
| offline | offline-tab-myynti | shift_video | PASS | FAIL | PASS |  |
| pankki | kirjanpito-match-open | shift_video | FAIL | PASS | PASS | fixed |
| pankki | kirjanpito-purchases-open | shift_probe | FAIL | PASS | PASS | fixed |
| raportit | raportit-drill-open | shift_video | FAIL | FAIL | FAIL |  |
| raportit | raportit-prev-year | shift_probe | FAIL | PASS | PASS | fixed |
| raportit | raportit-prev-year | shift_video | FAIL | PASS | PASS | fixed |
| raportit | raportit-refresh | shift_video | PASS | FAIL | PASS |  |
| raportit | raportit-scroll | intermediate | FAIL | PASS | PASS | fixed |
