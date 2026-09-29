"use client";

import { useId } from "react";
import Link from "next/link";
import { FileUp, PenLine } from "lucide-react";
import BottomSheet from "@/components/BottomSheet";
import { Icon, IconTile } from "@/components/ds";

/**
 * "Mitä tarvitaan" (BOOKS-03): why "Yhdistä pankki" cannot work yet, in plain
 * Finnish, and the two routes that work today. Never a setting name (L5).
 */
export default function BankSetupSheet({
  isOpen,
  onClose,
  onAddManual,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Opens the manual account form; without it the row links to Pankkitilit. */
  onAddManual?: () => void;
}) {
  const titleId = useId();
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Mitä tarvitaan" labelledBy={titleId} dirty={false}>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-2 pt-1 sheet-safe-bottom">
        <div className="space-y-3 text-body leading-relaxed text-ink">
          <p>
            Pankkiyhteys hakee tilitapahtumat suoraan pankista Enable Banking -palvelun kautta. Sitä
            varten palvelimelle tarvitaan kaksi asiaa:
          </p>
          <ol className="list-decimal space-y-1.5 pl-5 marker:text-ink-2">
            <li>Enable Banking -sovelluksen tunnus</li>
            <li>Sovelluksen yksityinen avain</li>
          </ol>
          <p className="text-caption text-ink-2">
            Lisäksi sovelluksen paluuosoite hyväksytään Enable Bankingin hallinnassa. Kun tunnukset on
            asetettu, &ldquo;Yhdistä pankki&rdquo; toimii tästä samasta kohdasta, eikä sovellusta
            tarvitse päivittää.
          </p>
        </div>

        <div>
          <p className="mb-2 px-1 text-caption text-ink-2">Toimii jo nyt</p>
          <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
            <Link
              href="/pankki/tapahtumat"
              onClick={onClose}
              className="active-press flex min-h-14 items-center gap-3 px-4 py-3"
            >
              <IconTile>
                <Icon icon={FileUp} />
              </IconTile>
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-ink">Tuo tiliote tiedostona</span>
                <span className="block text-caption text-ink-2">PDF, XML, XLSX tai CSV verkkopankista</span>
              </span>
            </Link>
            {onAddManual ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onAddManual();
                }}
                className="active-press flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left"
              >
                <ManualRowBody />
              </button>
            ) : (
              <Link
                href="/kirjanpito/pankkitilit"
                onClick={onClose}
                className="active-press flex min-h-14 items-center gap-3 px-4 py-3"
              >
                <ManualRowBody />
              </Link>
            )}
          </div>
        </div>
      </div>
    </BottomSheet>
  );
}

function ManualRowBody() {
  return (
    <>
      <IconTile>
        <Icon icon={PenLine} />
      </IconTile>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-ink">Lisää tili käsin</span>
        <span className="block text-caption text-ink-2">Saldot kirjataan itse kuukausittain</span>
      </span>
    </>
  );
}
