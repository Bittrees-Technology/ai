/** Counts confirmed source mappings, never the number of extracted candidates. */
export function crmProgress(snapshot: any) {
  const mapped = new Set<string>();
  for (const link of snapshot.links || [])
    if (link.status === "available" && typeof link.entryId === "string")
      mapped.add(link.entryId);
  for (const submission of snapshot.submissions || [])
    if (submission.status === "reviewed")
      for (const link of submission.mappings || [])
        if (
          typeof link.entryId === "string" &&
          typeof link.recordId === "string"
        )
          mapped.add(link.entryId);
  const people = snapshot.entries.filter((e: any) => e.kind === "people");
  const organizations = snapshot.entries.filter(
    (e: any) => e.kind === "organizations",
  );
  return {
    checkedAt: new Date().toISOString(),
    researchPeople: people.length,
    researchOrganizations: organizations.length,
    crmPeople: people.filter((e: any) => mapped.has(e.id)).length,
    crmOrganizations: organizations.filter((e: any) => mapped.has(e.id)).length,
    entryIds: [...mapped].filter((id) =>
      snapshot.entries.some((e: any) => e.id === id),
    ),
  };
}
