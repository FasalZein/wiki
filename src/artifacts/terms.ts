export type Term = {
  name: string;
  body: string;
};

const intro = "# Domain Language\n\n> Canonical terms for this project. Maintained by `wiki term set`.";

export function parseTerms(text: string): Term[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const matches = [...normalized.matchAll(/^## (.+)$/gm)];
  return matches.map((match, index) => {
    const name = match[1] ?? "";
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[index + 1];
    const end = next?.index ?? normalized.length;
    return { name, body: normalized.slice(start, end).trim() };
  });
}

export function getTerm(text: string, name: string): string | undefined {
  return parseTerms(text).find((term) => term.name === name)?.body;
}

export function listTerms(text: string): string[] {
  return parseTerms(text)
    .map((term) => term.name)
    .sort((left, right) => left.localeCompare(right));
}

export function upsertTerm(text: string, name: string, body: string): string {
  const terms = parseTerms(text).filter((term) => term.name !== name);
  terms.push({ name, body: body.trim() });
  terms.sort((left, right) => left.name.localeCompare(right.name));

  const sections = terms.map((term) => `## ${term.name}\n\n${term.body}`).join("\n\n");
  return `${intro}\n\n${sections}\n`;
}
