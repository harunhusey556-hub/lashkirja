/** Name rules shared by the profile form; the server enforces the same ones. */
export const NAME_MAX_LENGTH = 120;

export interface NameErrors {
  firstName?: string;
  lastName?: string;
}

/** What is wrong with the two names as typed, in plain Finnish. Empty when fine. */
export function validateProfileNames(firstName: string, lastName: string): NameErrors {
  const errors: NameErrors = {};
  const first = firstName.trim();
  const last = lastName.trim();
  if (!first) errors.firstName = "Anna etunimi.";
  else if (first.length > NAME_MAX_LENGTH) errors.firstName = `Etunimi saa olla enintään ${NAME_MAX_LENGTH} merkkiä.`;
  if (!last) errors.lastName = "Anna sukunimi.";
  else if (last.length > NAME_MAX_LENGTH) errors.lastName = `Sukunimi saa olla enintään ${NAME_MAX_LENGTH} merkkiä.`;
  return errors;
}
