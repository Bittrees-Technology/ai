// Conservative screening: an office, birthplace, former job or nationality is not a current personal base.
const normalize = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, " ").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const usLocation =
  /^(?:(?:the )?United States(?: of America)?|USA|U\.S\.|New York(?: City)?|San Francisco|Los Angeles|Chicago|Boston|Miami|Austin|Dallas|Denver|Seattle|Palo Alto|Menlo Park|Washington,? D\.?C\.?|California|Texas|Florida|North Carolina|Connecticut)(?:\b|$)/i;
export function personUSLocation(
  text: string,
  name: string,
  quote: string,
  title?: string,
): boolean {
  const source = normalize(text),
    evidence = normalize(quote);
  if (
    !evidence ||
    evidence.length > 500 ||
    !source.toLowerCase().includes(evidence.toLowerCase())
  )
    return false;
  // Require the person's full name and an explicit current location in the same clause.
  const subject = new RegExp(
    `\\b${escape(normalize(name))}\\s+(?:is\\s+(?:currently\\s+)?(?:based|located)|lives|resides)\\s+in\\s+([^;.!?]+)`,
    "gi",
  );
  const claims = [...evidence.matchAll(subject)];
  const cityCards: Record<string, string> = {
    "new york": "NY",
    "new york city": "NY",
    "los angeles": "CA",
    "san francisco": "CA",
    boston: "MA",
    chicago: "IL",
    miami: "FL",
    austin: "TX",
    dallas: "TX",
    denver: "CO",
    seattle: "WA",
    "palo alto": "CA",
    "menlo park": "CA",
    washington: "DC",
  };
  let card = false;
  for (const cardTitle of title
    ? [
        title,
        ...[
          "Managing Director Chief Investment Officer",
          "Managing Director Portfolio Manager",
          "Chief Investment Officer",
          "Portfolio Manager",
          "Managing Partner",
        ].filter((r) => r.toLowerCase().includes(title.toLowerCase())),
      ]
    : [
        "Managing Director Chief Investment Officer",
        "Managing Director Portfolio Manager",
        "Chief Investment Officer",
        "Portfolio Manager",
        "Managing Partner",
      ]) {
    // Entire quote must be one person/title/location card, never a paragraph with a firm address.
    const row = evidence.replace(/^\d+\s+/, "");
    const prefix = new RegExp(
      `^${escape(normalize(name))}\\s+(?:\\d+\\s+)?${escape(normalize(cardTitle))}\\s+`,
      "i",
    );
    const match = row.match(prefix);
    if (match) {
      const location = row
        .slice(match[0].length)
        .replace(/\.$/, "")
        .toLowerCase();
      card ||= Object.entries(cityCards).some(
        ([city, state]) => location === `${city}, ${state.toLowerCase()}`,
      );
    }
  }
  if (!card && !claims.some((m) => usLocation.test(m[1]!.trim()))) return false;
  // Any explicit conflicting current-base statement about the same named person blocks publication.
  for (const match of source.matchAll(subject))
    if (!usLocation.test(match[1]!.trim())) return false;
  return true;
}

/** Recover a complete literal card when the model supplied only its city/state cell. */
export function recoverPersonLocation(
  text: string,
  name: string,
  title: string,
): string | undefined {
  const source = normalize(text);
  const roles = [
    ...new Set([
      title,
      ...[
        "Managing Director Chief Investment Officer",
        "Managing Director Portfolio Manager",
        "Chief Investment Officer",
        "Portfolio Manager",
        "Managing Partner",
      ].filter((r) => r.toLowerCase().includes(title.toLowerCase())),
    ]),
  ];
  const candidates = new Set<string>();
  for (const role of roles) {
    const pattern = new RegExp(
      `\\b${escape(normalize(name))}\\s+(?:\\d+\\s+)?${escape(normalize(role))}\\s+[A-Za-z ]{2,30},\\s*[A-Z]{2}\\b`,
      "gi",
    );
    for (const match of source.matchAll(pattern)) {
      if (
        /^\s+(?:headquarters|office|firm|company|corporate|address)\b/i.test(
          source.slice(match.index! + match[0].length),
        )
      )
        continue;
      if (personUSLocation(source, name, match[0], role))
        candidates.add(match[0]);
      if (candidates.size > 1) return undefined;
    }
  }
  return [...candidates][0];
}
