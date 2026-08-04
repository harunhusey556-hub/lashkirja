/**
 * OmaVero ALV return field codes (subset used by this app).
 * Source: Verohallinto record description VSRALVKV (29.8.2024, updated 3.12.2025)
 * https://www.vero.fi/contentassets/ef5905e0f5b74bcba89aa9ba9c34015d/verohallinto_tietuekuvaus_vsralvkv_290824.pdf
 *
 * General rate is 25,5 % since 1.9.2024 (24 % before, same field).
 * Reduced rate is 13,5 % since 1.1.2026 (14 % before, same field).
 * Field 308 check (#1924): 308 = (301+302+303+304+305+306+318) − 307.
 * Alarajahuojennus (field 317) is not reported for periods ending on/after 1.1.2025.
 */
export const OMAVERO_FIELDS = {
  301: "Vero kotimaan myynnistä 25,5 % (24 % ennen 1.9.2024)",
  302: "Vero kotimaan myynnistä 13,5 % (14 % ennen 1.1.2026)",
  303: "Vero kotimaan myynnistä 10 %",
  304: "Vero palveluostoista muista EU-maista",
  305: "Vero tavaraostoista muista EU-maista",
  306: "Vero tavaroiden maahantuonnista EU:n ulkopuolelta",
  307: "Verokauden vähennettävä vero",
  308: "Maksettava vero / Palautukseen oikeuttava vero (-)",
  309: "0-verokannan alainen liikevaihto",
  318: "Vero rakentamispalvelun ja metalliromun ostoista",
} as const;

/** Domestic VAT rate → OmaVero sales-VAT field. Legacy rates map to the same field. */
export const RATE_TO_FIELD: Record<number, 301 | 302 | 303> = {
  25.5: 301,
  24: 301,
  13.5: 302,
  14: 302,
  10: 303,
};

/** ALV registration threshold (calendar-year turnover), effective 1.1.2026. */
export const VAT_REGISTRATION_THRESHOLD_EUR = 20000;
