/** Conservative duplicate screening. A match holds a candidate; it never merges identities. */
function parts(name: string) {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\b(?:cfa|cpa|mba|phd|ph\.d\.?|c\.f\.a\.?)\b/gi, " ")
    .replace(/^(?:dr|mr|mrs|ms|prof)\.?\s+/i, "")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
export function possibleSamePerson(left: string, right: string): boolean {
  const a = parts(left),
    b = parts(right);
  if (!a.length || !b.length) return false;
  if (a.join(" ") === b.join(" ")) return true;
  if (a.length < 2 || b.length < 2) return false;
  // Generational suffixes are identity-bearing; do not collapse parent and child.
  const suffix = /^(jr|sr|ii|iii|iv)$/;
  if (suffix.test(a.at(-1)!) || suffix.test(b.at(-1)!)) {
    if (a.at(-1) !== b.at(-1)) return false;
    a.pop();
    b.pop();
  }
  if (a.length < 2 || b.length < 2 || a.at(-1) !== b.at(-1)) return false;
  const compatible = (x: string, y: string) =>
    x === y || ((x.length === 1 || y.length === 1) && x[0] === y[0]);
  if (!compatible(a[0]!, b[0]!)) return false;
  const am = a.slice(1, -1),
    bm = b.slice(1, -1);
  if (!am.length || !bm.length) return true;
  return am.length === bm.length && am.every((v, i) => compatible(v, bm[i]!));
}
export function personMatches(
  candidate: { id: string; name: string },
  entries: { id: string; name: string; kind: string }[],
) {
  return entries.filter(
    (e) =>
      e.kind === "people" &&
      e.id !== candidate.id &&
      possibleSamePerson(candidate.name, e.name),
  );
}
