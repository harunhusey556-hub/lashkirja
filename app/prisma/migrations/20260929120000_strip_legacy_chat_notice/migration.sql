-- Data-only migration (OWN-09 / SHELL-11). No schema change.
--
-- Replies generated before quality batch 1 start with a "Rajattu tila" /
-- "Limited mode" paragraph. The generator no longer writes it; this removes it
-- from the stored assistant replies so old conversations stop showing it.
-- A reply that was only the notice becomes the current calm notice.
--
-- Idempotent: after the update no row starts with the old text, so a re-run
-- (or a restored backup that is migrated again) changes nothing else.
-- The strings must stay byte-identical to src/lib/chat-legacy.ts and
-- src/lib/chat-policy.ts (checked by src/lib/chat-legacy.test.ts).

UPDATE "ChatMessage"
SET "content" = CASE
  WHEN ltrim(substr("content", length('Rajattu tila: kielimallia ei ole yhdistetty, joten tämä ei ole mallin vastaus. Voin silti käyttää kirjanpitoasi täsmäytykseen, ALV-sääntöihin ja laskettuihin summiin.') + 1), char(9, 10, 13, 32)) = ''
    THEN 'Tähän en osaa vielä vastata. Voin täsmäyttää kuitit tiliotteeseen ja kertoa tämän kuun ALV:n.'
  ELSE ltrim(substr("content", length('Rajattu tila: kielimallia ei ole yhdistetty, joten tämä ei ole mallin vastaus. Voin silti käyttää kirjanpitoasi täsmäytykseen, ALV-sääntöihin ja laskettuihin summiin.') + 1), char(9, 10, 13, 32))
END
WHERE "role" = 'assistant'
  AND substr("content", 1, length('Rajattu tila: kielimallia ei ole yhdistetty, joten tämä ei ole mallin vastaus. Voin silti käyttää kirjanpitoasi täsmäytykseen, ALV-sääntöihin ja laskettuihin summiin.')) = 'Rajattu tila: kielimallia ei ole yhdistetty, joten tämä ei ole mallin vastaus. Voin silti käyttää kirjanpitoasi täsmäytykseen, ALV-sääntöihin ja laskettuihin summiin.';

UPDATE "ChatMessage"
SET "content" = CASE
  WHEN ltrim(substr("content", length('Limited mode: the language provider is not connected, so this is not a model answer. I can still use your books for matching, VAT rules, and calculated amounts.') + 1), char(9, 10, 13, 32)) = ''
    THEN 'I can''t answer that yet. I can match receipts to bank rows and tell you this month''s VAT.'
  ELSE ltrim(substr("content", length('Limited mode: the language provider is not connected, so this is not a model answer. I can still use your books for matching, VAT rules, and calculated amounts.') + 1), char(9, 10, 13, 32))
END
WHERE "role" = 'assistant'
  AND substr("content", 1, length('Limited mode: the language provider is not connected, so this is not a model answer. I can still use your books for matching, VAT rules, and calculated amounts.')) = 'Limited mode: the language provider is not connected, so this is not a model answer. I can still use your books for matching, VAT rules, and calculated amounts.';
