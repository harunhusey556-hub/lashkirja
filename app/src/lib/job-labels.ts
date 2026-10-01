export const JOB_KIND_LABEL: Record<string, string> = {
  document_analysis: "Kuitin lukeminen",
  bank_sync: "Pankkitapahtumien haku",
  email_scan: "Sähköpostin tarkistus",
};

export const JOB_STATUS_LABEL: Record<string, string> = {
  pending: "Jonossa",
  running: "Käynnissä",
  failed: "Epäonnistui",
  done: "Valmis",
  cancelled: "Peruttu",
};

export const WORK_KIND_LABEL: Record<string, string> = {
  pending_review: "Odottaa tarkistusta",
  missing_document: "Kuitti puuttuu",
  amount_mismatch: "Summa ei täsmää",
  corrupt_file: "Kuittia ei voitu lukea",
  link_error: "Kohdistus ei onnistunut",
  ambiguous_match: "Epäselvä kohdistus",
  payment_duplicate: "Mahdollinen tuplamaksu",
};

export function jobKindLabel(kind: string): string {
  return JOB_KIND_LABEL[kind] ?? "Työ";
}

export function jobStatusLabel(status: string): string {
  return JOB_STATUS_LABEL[status] ?? status;
}

export function workKindLabel(kind: string): string {
  return WORK_KIND_LABEL[kind] ?? "Huomioitava";
}
