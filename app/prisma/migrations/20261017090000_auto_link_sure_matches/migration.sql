-- Kohdista varmat automaattisesti (owner 2026-10-15). Off by default; purely additive.
ALTER TABLE "User" ADD COLUMN "autoLinkSureMatches" BOOLEAN NOT NULL DEFAULT false;
