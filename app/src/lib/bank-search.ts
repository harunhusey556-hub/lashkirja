/**
 * Bank picker search. A plain substring match let one letter match nearly
 * every bank ("a" is in most names), so the list jumped on each keystroke.
 * Here each typed word must start a word of the bank's name, and Finnish
 * letters match their plain forms: "saasto" finds Säästöpankki, "op" finds
 * OP but not Danske Bank Corporate.
 */
function fold(text: string): string {
  return text
    .toLocaleLowerCase("fi")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function words(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function bankMatches(name: string, query: string): boolean {
  const typed = words(query);
  if (typed.length === 0) return true;
  const nameWords = words(name);
  const joined = nameWords.join("");
  return typed.every((part) => nameWords.some((word) => word.startsWith(part)) || joined.startsWith(typed.join("")));
}
