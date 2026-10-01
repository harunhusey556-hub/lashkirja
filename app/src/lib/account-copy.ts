/**
 * Account wording shared by the API routes and the screens, so a toast, a
 * dialog and a login refusal cannot tell different stories. No database and no
 * Node-only imports: the static client imports this too.
 */
import { ACCOUNTING_RETENTION_YEARS } from "@/lib/session-policy";

/**
 * The support address the build or server carries, or "". NEXT_PUBLIC_ is read
 * literally so the static export can inline it; SUPPORT_EMAIL is the server
 * fallback.
 */
export function supportEmail(): string {
  const value = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL || "";
  return value.trim();
}

/** "ota yhteyttä tukeen" with the address when one is configured. */
export function contactSupportPhrase(address: string = supportEmail()): string {
  return address ? `ota yhteyttä tukeen: ${address}` : "ota yhteyttä tukeen";
}

/**
 * Where to write, as the help page says it (F54). With an address it is named;
 * without one the page says so and points to the report button that exists,
 * instead of promising a contact it cannot show.
 */
export function supportContactLine(address: string = supportEmail()): string {
  if (address) return `Voit myös kirjoittaa suoraan osoitteeseen ${address}.`;
  return "Tukiosoitetta ei ole vielä määritetty tähän versioon. Ilmoita ongelmasta -painike avaa jaon, jolla voit lähettää viestin sille, joka sovelluksen sinulle antoi.";
}

/** The toast after the report text was copied instead of shared. */
export function reportCopiedToast(address: string = supportEmail()): string {
  return address
    ? `Viesti kopioitu. Liitä se sähköpostiin osoitteeseen ${address}.`
    : "Viesti kopioitu. Liitä se viestiin ja lähetä se sovelluksen ylläpitäjälle.";
}

/**
 * The one answer to a password-recovery request. It depends only on whether
 * this server can send mail at all, never on the address typed, so it does not
 * reveal which accounts exist.
 */
export function forgotPasswordMessage(mailConfigured: boolean, address: string = supportEmail()): string {
  if (!mailConfigured) {
    const contact = contactSupportPhrase(address);
    return `Palautuslinkkiä ei voida lähettää tästä palvelusta automaattisesti. Voit ${contact}, niin autamme sinut takaisin sisään.`;
  }
  return `Jos osoitteella löytyy tili, palautuslinkki on matkalla. Tarkista myös roskaposti. Jos viestiä ei kuulu muutamassa minuutissa, ${contactSupportPhrase(address)}.`;
}

/** What closing the account does. Used by the dialog, the page intro, the toast and the login refusal. */
export const CLOSE_RETENTION_COPY = `Kuitit, laskut ja tiliotteet säilyvät ${ACCOUNTING_RETENTION_YEARS} vuotta, koska laki vaatii sen.`;
export const CLOSE_PURGE_COPY =
  "Yhdistetty postilaatikko ja avustajan keskustelut poistetaan. Pankkiyhteys katkaistaan pankissa. Jos pankki ei vastaa, suostumus päättyy itsestään, tai voit päättää sen oman pankkisi sovelluksessa.";
export const CLOSE_NEXT_COPY = "Tuki käsittelee pyynnön ja ilmoittaa sinulle sähköpostilla. Sen jälkeen kirjautuminen estetään.";

export const CLOSE_REQUEST_MESSAGE = `Pyyntö on kirjattu. ${CLOSE_NEXT_COPY} ${CLOSE_PURGE_COPY} ${CLOSE_RETENTION_COPY}`;

export const CLOSED_LOGIN_MESSAGE = `Tilin käyttö on suljettu. ${CLOSE_RETENTION_COPY} Tietojen kopiota tai kysymyksiä varten ${contactSupportPhrase()}.`;
