export const JOB_KIND_LABEL: Record<string, string> = {
  document_analysis: "Asiakirjan analysointi",
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
  missing_document: "Puuttuva tosite",
  amount_mismatch: "Summa ei täsmää",
  corrupt_file: "Tiedosto rikki",
  link_error: "Linkitysvirhe",
  ambiguous_match: "Epäselvä täsmäytys",
};

export function jobKindLabel(kind: string): string {
  return JOB_KIND_LABEL[kind] ?? "Taustatyö";
}

export function jobStatusLabel(status: string): string {
  return JOB_STATUS_LABEL[status] ?? status;
}

export function workKindLabel(kind: string): string {
  return WORK_KIND_LABEL[kind] ?? "Poikkeus";
}
