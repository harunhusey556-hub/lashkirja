# LashKirja — Pre-Launch Product and Engineering Plan

_Source: Harun, 2026-08-05. Companion doc: [ARCHITECTURE.md](./ARCHITECTURE.md)._

## 1. Executive Summary

LashKirja aims to replace a large part of the traditional bookkeeping workload for Finnish sole traders and small limited companies with a highly automated system.

The application should not feel like accounting software that requires constant manual work. It should feel like a reliable assistant that quietly handles recurring bookkeeping tasks, learns how the user's business operates, identifies unusual situations, and only asks for help when a decision cannot be made safely.

The immediate priority is not to add an AI chat interface. The application first needs a stronger operational foundation:

- Reliable transaction and receipt processing
- Safe bookkeeping automation
- Learning from previous user decisions
- Detailed error detection and recovery
- Clear exception handling
- Reversible automated decisions
- Background job processing
- Strong auditability
- Production-grade security, testing, monitoring, and backups

Target user experience: **LashKirja handles routine bookkeeping automatically and only asks the user about genuine exceptions.**

## 2. Main Goal

Build a bookkeeping application that can manage the majority of monthly bookkeeping work for small Finnish businesses without requiring the user to review every receipt, invoice, or bank transaction.

The system should be capable of:

1. Importing receipts, invoices, emails, and bank statements
2. Extracting structured accounting information
3. Matching documents with bank transactions
4. Classifying income and expenses
5. Learning recurring business patterns
6. Applying previously approved accounting rules
7. Calculating VAT from verified information
8. Detecting missing, conflicting, or unusual data
9. Resolving technical problems automatically when possible
10. Presenting only unresolved exceptions to the user
11. Keeping a complete audit trail of all automated decisions
12. Allowing every important automated decision to be reversed

The user should not need to understand accounting terminology to use the application.

## 3. Target Customer

### Primary target (v1)

- Finnish sole traders
- Light entrepreneurs with direct bookkeeping responsibilities
- Small service businesses
- Entrepreneurs with no employees or very few employees
- Monthly turnover below approximately €10,000
- Recurring customers and suppliers
- One main bank account
- Mostly domestic Finnish transactions
- Simple VAT treatment
- Fewer than approximately 100–150 monthly transactions

### Good initial industries

Beauty professionals · lash and nail technicians · hairdressers · massage therapists · personal trainers · photographers · consultants · freelancers · small repair and maintenance businesses · small digital service providers

### Initially unsupported or restricted

- Large inventory-based businesses
- International VAT-heavy businesses
- Import and export businesses
- Complex payroll
- Construction reverse-charge VAT cases
- Multiple bank accounts / large companies
- Multiple currencies
- Group structures
- Frequent loans, investments, or asset purchases

These may be supported later through specialized accounting workflows.

## 4. Product Vision

Four principles.

### 4.1 Routine work should disappear

Known and repeated transactions handled automatically: monthly phone bills, rent, software subscriptions, YEL payments, insurance, known supplier invoices, repeated customer payments, payment processor settlements, bank service fees.

Once enough verified history exists, these should no longer require user attention.

### 4.2 Unknown situations should become exceptions

Ask the user only when:

- A new type of transaction appears
- VAT treatment is uncertain
- The amount is abnormal
- A receipt is missing
- Multiple possible matches exist
- The transaction conflicts with previous behavior
- A document contains inconsistent values
- A technical process has failed repeatedly

### 4.3 The system should learn from corrections

Every user correction improves future automation. When the user classifies a transaction, the system decides whether the decision applies only to that transaction or should become a reusable rule.

Example: user marks a recurring payment from the same sender as an owner contribution → remember sender, payment pattern, transaction characteristics → classify similar future payments automatically.

### 4.4 Every automatic action must be explainable and reversible

The system must always answer: What did it do? Why? Which data supported it? Which rule was used? How confident? What would change if reversed? Can it be safely reversed?

## 5. Current State

### Existing strengths

Next.js + TypeScript structure · Prisma DB · auth and sessions · receipt/invoice upload · OCR + AI extraction · bank statement import · CSV/XLSX/XML/PDF parsing · transaction↔receipt matching · VAT reports · receipt review states · IMAP email sync · private file storage · security headers · auth rate limiting · DB backup script · expired upload cleanup · background email worker · Finnish UI · categorization

### Current weaknesses

Functionally ambitious, but some automation treats uncertain information as confirmed accounting data:

- Unknown bank income may be converted directly into approved VAT-bearing sales
- Pending documents may enter automated matching
- Some automatic matches are too aggressive
- Bank statement uploads less secure than receipt uploads
- Duplicate statement detection incomplete
- VAT may be inferred from categories without sufficient proof
- Some API mutations lack consistent cross-site request protection
- IMAP configuration can create server-side network access risks (SSRF)
- Background processing lacks a structured job system
- Error handling scattered across individual routes
- Automated decisions not stored in a complete audit model
- User corrections do not create reusable learning rules
- No unified exception management system
- No production CI pipeline
- Some code paths may fail type checking or production build

Treat current app as **capable prototype, not yet an autonomous bookkeeping system.**

## 6. Strategic Direction

Shift from feature expansion to operational strengthening.

**Not next:** AI chat · more dashboard charts · more visual features · more document formats · more automatic assumptions · every company type · financial forecasting

**Next:** reliable automation · controlled learning · error recovery · safe VAT treatment · auditability · background processing · exception-focused UX · production reliability

## 7. Core Architecture to Add

### 7.1 Bookkeeping processing pipeline

```text
received
→ validated
→ extracted
→ classified
→ matched
→ verified
→ posted
```

Failure states:

```text
validation_failed
extraction_failed
classification_uncertain
match_conflict
vat_uncertain
missing_document
technical_retry
manual_review
```

Every receipt, statement, transaction, and imported email has a visible processing status. The application must never silently stop processing an item.

### 7.2 Background job system

OCR, PDF processing, email sync, matching, classification, and report recalculation must not run as uncontrolled work inside normal API requests.

Each job includes: job type · user ID · related entity · status · attempts · max attempts · last error code · last error message · next retry time · start time · completion time · duration · idempotency key

Statuses:

```text
queued
processing
completed
retrying
failed
cancelled
```

Job examples: process receipt · extract document data · generate preview · sync email account · import bank statement · match transactions · recalculate VAT report · evaluate automation rules · clean expired uploads · validate backups

**All jobs must be idempotent.** Running the same job twice must not create duplicate receipts, transactions, or accounting entries.

### 7.3 Central event system

```text
receipt.uploaded
receipt.extraction_completed
receipt.extraction_failed
statement.imported
statement.duplicate_detected
transaction.classified
transaction.match_suggested
transaction.match_confirmed
automation.rule_applied
automation.rule_rejected
vat.validation_failed
email.sync_failed
backup.completed
backup.failed
```

Each event contains: user ID · event type · severity · related entity · technical details · user-facing explanation · suggested resolution · retryable? · user action required? · resolution status · created/resolved timestamps

Powers: home screen status · notifications · support tools · error recovery · future AI features · audit logs

## 8. Learning and Automation Rules

### 8.1 Automation rule model

A rule may describe: counterparty · IBAN hash · reference pattern · description pattern · amount range · expected frequency · transaction type · accounting category · VAT treatment · receipt matching behavior · document required? · may post automatically?

Example:

```text
Counterparty: Elisa
Type: Expense
Category: Phone and Internet
VAT treatment: Use VAT shown on invoice
Expected frequency: Monthly
Normal amount: €25–€80
Automatic posting: Allowed
```

### 8.2 Rule lifecycle

```text
candidate
observed
trusted
restricted
disabled
```

Promotion:

- 1st confirmed occurrence → create candidate
- 2nd matching occurrence → strengthen candidate
- 3rd confirmed occurrence → allow automatic classification
- 5th–10th successful occurrence → allow full automatic posting
- 1 user correction → reduce trust
- 2 similar corrections → disable automatic posting
- Major accounting conflict → disable immediately

### 8.3 Rule confidence must be evidence-based

Not one generic AI score. Combine independent evidence: counterparty match · IBAN match · reference pattern · amount similarity · frequency consistency · document availability · VAT consistency · previous user approvals · successful historical applications · corrections · conflicting candidates

### 8.4 Never learn from unverified automation

A rule strengthens **only** through: explicit user confirmation · verified document data · exact bank-to-document matching · previously trusted accounting rules · confirmed historical records.

Otherwise one wrong assumption creates repeated accounting errors.

## 9. Safe Automatic Income Processing

Do not automatically treat every incoming payment as revenue. Incoming types include: customer payment · owner contribution · loan · tax refund · insurance compensation · supplier refund · transfer between own accounts · payment processor settlement · deposit · other financing.

### Automatic sales classification requires evidence

At least one of:

- Exact invoice reference match
- Exact match with an approved sales document
- Trusted recurring customer rule
- Verified payment processor settlement rule
- Strong historical pattern with no conflicting classification

Without sufficient evidence → create an **exception**, not an approved sale.

### Payment processors need separate handling

Stripe, Zettle, SumUp, MobilePay et al. transfer **net** settlement after fees. The bank deposit may not equal gross sales. May need to record: gross sales · VAT · processing fee · VAT on processing fee · net bank deposit.

Do not calculate VAT from the net settlement unless the provider-specific accounting model proves the amount represents gross sales.

## 10. VAT Safety

Distinguish extracted facts from inferred assumptions.

### Extracted VAT (verified) when

- Document clearly contains the VAT rate
- Document clearly contains the VAT amount
- Taxable amount, VAT amount, and total are mathematically consistent
- Document is valid for business bookkeeping
- Expense is eligible for deduction

### Inferred VAT (uncertain) when

- Document does not show VAT
- Only the category suggests a rate
- Only the seller name suggests treatment
- Only the gross amount is known
- Business-use percentage unknown
- Deductibility unclear
- Payment processor settlement contains combined sales

Inferred VAT must not silently enter the final VAT return. It may be used for: provisional estimate · internal forecasting · exception prioritization · suggesting a likely answer.

### VAT report states

```text
estimated
incomplete
ready_for_review
validated
submitted
```

Never present a report as ready while unresolved VAT exceptions exist.

## 11. Matching System

### Full automatic confirmation requires

- Exact amount match
- Exact reference match or unique invoice number match
- Correct transaction direction
- No competing receipt
- No competing transaction
- Approved document
- No previous rejection between the pair

### Strong suggestion when

- Amount and counterparty match
- Amount and date are close
- Vendor name is similar
- Transaction occurs within a reasonable payment window

Suggestions must not automatically approve pending documents.

### Pending document rule

Documents with status `pending` must not enter automatic posting. They may be parsed, compared, and given match suggestions — but must not become approved merely because a bank match exists. **Document approval and bank matching remain separate accounting actions.**

## 12. Exception Management

Home screen is based on exceptions, not raw accounting data.

Normal state:

```text
Bookkeeping is up to date.

63 transactions processed
58 documents matched
Email connection working
VAT estimate updated

No action needed.
```

Exception state:

```text
I need one answer from you.

€1,250 received from a new sender.

What was this?

[Customer payment]
[My own money]
[Loan or financing]
[Something else]
```

### Exception categories

Missing receipt · unknown income · unknown expense · VAT mismatch · duplicate document · duplicate statement · multiple matching candidates · email auth failure · statement parsing failure · abnormal amount · new supplier · new customer · unusual VAT rate · failed background job · missing business-use percentage

### Prioritization

By tax impact · amount · filing deadline · duplicate-accounting risk · blocks month closing? · user can solve easily? · system can retry automatically?

## 13. Error Handling and Resolution Playbooks

Centralized error catalog. Every known error has: stable error code · technical description · user-friendly title · user-friendly explanation · severity · is data safe? · automatic retry possible? · automatic recovery actions · user actions · support actions · related documentation

```text
Code: IMAP_AUTH_FAILED

User message:
Your Gmail connection needs attention.

Google is no longer accepting the current app password.
Your existing receipts are safe, but new email receipts cannot be downloaded.

Action:
Reconnect Gmail
```

```text
Code: VAT_TOTAL_MISMATCH

User message:
The VAT values on this receipt do not match the total.

The receipt has been saved, but it has been excluded from the VAT calculation until the values are confirmed.

Action:
Review VAT
```

### Principles

- Never display only "Something went wrong"
- Never hide failed processing
- Never delete data after a recoverable failure
- Never mark a failed item as completed
- Always state whether existing data is safe
- Automatically retry temporary failures
- Stop retrying permanent failures
- Provide one primary user action
- Store technical details for support

## 14. Reversible Automation

Every important automatic action creates an automation decision record: user · rule used · entity changed · previous state · new state · reasons · confidence · supporting evidence · timestamp · reversible? · reversed? · reversed by whom

Examples: expense category assigned · transaction marked as revenue · receipt matched · VAT treatment applied · automation rule created · document approved · duplicate ignored

User selects `This decision is wrong` → system:

1. Restores the previous state
2. Reduces rule confidence
3. Re-evaluates related transactions
4. Identifies other records affected by the same rule
5. Asks whether those records should also be corrected

## 15. Home Screen Design

Answers four questions: Is bookkeeping up to date? Does the user need to do anything? Is anything failing? What is the next deadline?

Structure:

- **Status** — "Everything is up to date." / "Bookkeeping needs one answer."
- **Activity summary** — transactions processed · documents matched · rules applied · receipts imported · email sync status
- **Required actions** — only unresolved exceptions
- **Upcoming deadline** — VAT filing deadline · estimated amount payable · report complete? · remaining blockers
- **Recent automatic work** — calm activity feed:

```text
Elisa invoice classified automatically
Monthly rent matched
12 email receipts imported
July statement processed
```

Detailed accounting tables stay on secondary pages.

## 16. Security Improvements (pre-launch, required)

### Bank statement uploads

Max file size · validate actual content not extension · checksum · prevent duplicate uploads · private user-specific storage · remove failed files · secure permissions · cross-site request protection · limit parser resource usage

### IMAP

Block localhost and private networks (SSRF) · validate host and port · prefer approved provider presets · require encrypted connections in production · rate-limit connection testing · never expose raw provider errors · require cron authentication · **separate encryption secret from session secret** · support secret rotation

### API security

All state-changing routes consistently use: authentication · authorization · origin/cross-site validation · request-size limits · schema validation · rate limiting where appropriate · structured error responses

### Sensitive files

```text
*.db
*.db-wal
*.db-shm
.env
data/
backups/
uploads/
```

Secrets and local databases must never be committed.

## 17. Observability and Internal Support Tools

Internal operational dashboard before public launch showing: failed jobs · retrying jobs · email sync status · last successful bank import · parser failures · OCR failures · AI provider failures · duplicate detection events · VAT validation failures · automation decisions · rule confidence changes · DB backup status · cleanup status · app version · recent deployments

Per user issue, support sees: what happened · when · which step failed · whether the system retried · what the user saw · what data was affected · resolved?

Sensitive accounting data hidden by default; access logged.

## 18. Testing and CI

GitHub Actions on every commit and PR:

```text
npm ci
Prisma client generation
Database migration validation
ESLint
TypeScript type checking
Unit tests
Integration tests
Production build
End-to-end tests
```

### Essential test scenarios

**Uploads** — valid receipt · invalid extension · content/extension mismatch · oversized · duplicate · parser failure · cleanup after failure

**Matching** — exact reference+amount · same amount multiple receipts · same vendor recurring · pending receipt · rejected pair · duplicate statement · re-running matching

**Income** — customer payment · owner contribution · loan · refund · payment processor settlement · transfer between own accounts

**VAT** — 25.5% · 13.5% · 10% · VAT-exempt · missing VAT · incorrect VAT math · non-deductible · mixed VAT document

**Email** — auth failure · temporary network failure · duplicate attachment · large attachment · unsupported attachment · failure then retry · multiple IMAP accounts

**Recovery** — job runs twice · worker stops mid-processing · DB temporarily locked · backup fails · restore from backup · automatic decision reversed

## 19. Backup and Recovery

Creating backups is not enough — recovery must be tested.

Automatic daily DB backup · encrypted storage · retention policy · success monitoring · regular restore test · upload file backup · DB/file consistency validation · documented recovery process · RPO/RTO targets

At least one automated process regularly restores a backup into a test environment and verifies: DB opens · migrations valid · users exist · receipts readable · transactions queryable · file references valid

## 20. Privacy and Compliance

Before launch: privacy policy · terms of service · data processing description · data retention policy · user data deletion process · account export process · cloud AI provider disclosure · consent for email access · logging policy · access control policy · incident response plan

Users must clearly understand: which data is stored · where · whether documents go to external AI providers · retention period · how to remove an email connection · how to delete all data

## 21. Implementation Roadmap

### Phase 1 — Stop unsafe automation (Critical)

- Disable automatic conversion of all incoming transfers into approved sales
- Exclude pending receipts from automatic posting
- Separate receipt approval from bank matching
- Tighten automatic matching rules
- Fix current build and Prisma type inconsistencies
- Require authentication for all cron endpoints
- Add duplicate statement checks
- Prevent unsupported or oversized statement uploads

**Done when:** no uncertain income or pending document can silently enter confirmed bookkeeping.

### Phase 2 — Processing and job foundation (Critical)

- Background job model
- Retry handling
- Idempotency keys
- Processing statuses
- Move OCR, email sync, parsing, matching into jobs
- Centralized event logging
- Structured error codes

**Done when:** every background operation has a visible status, retry policy, and failure history.

### Phase 3 — Exception system (High)

- Exception data model
- Exception severity and deadlines
- Exception-only home screen
- Solution cards
- "Data is safe" explanations
- Automatic resolution playbooks
- Month-closing blocker checks

**Done when:** the user can understand and solve every unresolved issue without reading technical logs.

### Phase 4 — Learning system (High)

- Automation rule model
- Rule candidates
- Track successful and failed applications
- Generate rules from user corrections
- Trust promotion and demotion
- Rule explanation screen
- Prevent learning from unverified assumptions

**Done when:** recurring transactions become increasingly automatic while corrections reduce future errors.

### Phase 5 — Reversible bookkeeping automation (High)

- Automation decision audit records
- Store before and after state
- Reversal logic
- Re-evaluate affected records after reversal
- Show why every automated decision was made
- Related-record impact analysis

**Done when:** every important automated decision can be explained and safely reversed.

### Phase 6 — Production reliability (Critical before launch)

- Full CI pipeline
- Production monitoring
- Internal support dashboard
- Backup verification
- Restore testing
- IMAP SSRF protection
- Secrets management
- Consistent request security
- Load-test monthly transaction processing
- Test worker and SQLite concurrency

**Done when:** a failed deployment, parser, email sync, or background process is detected and recoverable.

### Phase 7 — Controlled beta (Final pre-launch step)

Beta group: 5–10 sole traders · simple domestic services · one bank account · stable monthly activity · no complex payroll · limited international transactions

Track: % transactions processed automatically · user questions per month · incorrect automatic decisions · VAT corrections · missing documents · rule creation rate · time spent in app · support requests · recovery failures

Target result: >90% of routine transactions automatic · <5 user decisions per month for a stable business · no silent VAT errors · no duplicate accounting · all automated decisions explainable · all critical actions reversible

## 22. Launch Criteria

### Bookkeeping safety

- Unknown income never automatically confirmed as sales without evidence
- Pending documents cannot enter final reports
- Duplicate statements cannot be imported
- VAT assumptions clearly separated from verified VAT
- Month closing detects unresolved accounting exceptions
- Automatic decisions auditable and reversible

### Reliability

- Every background job has retries
- Jobs are idempotent
- Failed jobs are visible
- Email sync failures are recoverable
- Backups automatically created and tested
- Production build and tests pass in CI

### Security

- All write routes protected
- Cron routes require secrets
- IMAP SSRF protection active
- Sensitive files excluded from Git
- Encryption secrets managed safely
- Uploads validated by actual content
- User files stored privately

### User experience

- Home screen clearly states whether action is required
- Every error includes a clear explanation and solution
- Users do not need to review every transaction
- Repeated corrections are remembered
- The same routine question is not repeatedly asked
- The application communicates what it handled automatically

### Operational readiness

- Internal support tools exist
- Errors use stable codes
- User-impacting incidents can be investigated
- Data deletion and export procedures exist
- Privacy and terms documents ready
- Beta users completed at least two full bookkeeping periods

## 23. Final Product Positioning

Not a cheaper traditional bookkeeping interface. Value = removing bookkeeping work from the entrepreneur's daily life.

Product promise: **LashKirja handles your bookkeeping and only asks for help when it genuinely needs you.**

Autonomy is earned through verified history, user-specific rules, strong validation, and reversible decisions. The goal is not to make the user approve more accounting entries faster — the goal is to make routine bookkeeping disappear.

---

# Target Market and Expansion Strategy

Long-term goal: serve a broad range of Finnish entrepreneurs and SMEs. Enter through a focused initial segment — a controlled launch strategy, not a permanent product limitation.

## 3.1 Initial Launch Segment

Finnish sole traders · light entrepreneurs · small service businesses · no or few employees · <€10k monthly turnover · one primary bank account · recurring customers and suppliers · mostly domestic · simple VAT · manageable transaction volume · no complex inventory/payroll/financing/international tax

Purpose: validate the autonomous bookkeeping model · measure how much manual work can be removed · identify recurring accounting exceptions · improve classification · improve VAT validation · test rule learning and correction handling · build trust through explainable and reversible automation · discover weaknesses before wider expansion

## 3.2 Long-Term Market Goal

Gradually expand to: higher-turnover sole traders · small limited companies · multiple bank accounts · companies with employees · payment processor settlements · AR/AP · recurring subscriptions and contracts · assets and depreciation · inventory-based businesses · multiple VAT categories · domestic + international · accountant collaboration · advanced reporting

The initial segment is the first stage of a wider product evolution, not the final market.

## 3.3 Expansion Through Controlled Complexity

One complexity layer at a time; each new segment only after the previous level is reliable.

**Stage 1 — Simple Sole Traders**
One main bank account · domestic income/expenses · basic VAT · no employees · low volume · recurring suppliers and customers · cash-based operational view.
*Objective:* prove routine bookkeeping can be automated safely with very little user involvement.

**Stage 2 — Advanced Sole Traders**
Multiple bank accounts · higher volumes · business-use percentages · equipment purchases · asset tracking · depreciation · loans and financing · advanced deductibility · multiple sales channels · improved year-end workflows.
*Objective:* support owner-managed bookkeeping with more accounting exceptions.

**Stage 3 — Small Limited Companies**
Double-entry workflows · balance sheet accounts · owner/company transactions · AR · AP · payroll integrations · accruals · period closing · dividends and shareholder transactions · accountant review workflows · role-based access.
*Objective:* expand from personal entrepreneur bookkeeping into structured company accounting.

**Stage 4 — Growing Small Businesses**
Multiple users · approval workflows · department/project accounting · cost centres · inventory · multiple currencies · international VAT · EU transactions · imports/exports · advanced cash-flow reporting · forecasting · external accountant collaboration · stronger audit and compliance.
*Objective:* support companies that outgrew basic tools but still want automation over traditional accounting processes.

## 3.4 Architecture Must Support Future Growth

Do **not** permanently assume: one bank account per user · one business per account · one user per business · one VAT treatment per transaction · one receipt per bank transaction · one bank transaction per receipt · cash-basis only · domestic only · euros only · no payroll · no inventory · no assets · no accountant access · no approval workflow.

The initial UI may hide advanced concepts, but the data model must be able to support them later.

## 3.5 Business Complexity Profile

Assign each business a complexity profile rather than classifying only by company type. Considers: monthly transaction volume · bank accounts · users · employees · currencies · domestic vs international · VAT complexity · payroll · inventory · assets and depreciation · loans and financing · sales channels · unresolved monthly exceptions.

```text
Level 1 — Simple
Level 2 — Standard
Level 3 — Advanced
Level 4 — Complex
```

## 3.6 Feature Gating

- Basic users see only routine bookkeeping and exceptions
- Businesses with employees get payroll workflows
- Businesses with assets get depreciation management
- Businesses with international transactions get international VAT workflows
- Companies with external accountants get review and approval tools
- Businesses with multiple users get permissions and role management

Keeps the app simple for small customers while the same product supports larger ones.

## 3.7 Expansion Criteria

Support a new segment only when: required accounting rules researched · data model supports the complexity · automated decisions explainable · mistakes reversible · new exception types have resolution workflows · relevant tax/accounting cases covered by tests · beta customers from the segment completed multiple periods · no unresolved issue can silently affect VAT, financial statements, or tax reporting.

Expansion is based on verified operational capability, not new interface features.

## 3.8 Strategic Positioning

Start with the businesses whose bookkeeping patterns are easiest to understand, use them to build a reliable autonomous accounting engine, then expand that engine to increasingly complex companies.
