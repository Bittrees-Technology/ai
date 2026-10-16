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
  if (!claims.length || !claims.some((m) => usLocation.test(m[1]!.trim())))
    return false;
  // Any explicit conflicting current-base statement about the same named person blocks publication.
  for (const match of source.matchAll(subject))
    if (!usLocation.test(match[1]!.trim())) return false;
  return true;
}
