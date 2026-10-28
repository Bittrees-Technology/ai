export const WEEKLY_RESEARCH_INTERVAL = 7 * 24 * 60 * 60 * 1000;
export function weeklyResearchDue(last: number, now = Date.now()) {
  return (
    Number.isFinite(last) &&
    last >= 0 &&
    Number.isFinite(now) &&
    now >= last &&
    now - last >= WEEKLY_RESEARCH_INTERVAL
  );
}
export async function requireResearchBrief(response: Response, host?: string) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Research brief: empty MCP response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64000)
        throw Error("Research brief: MCP response exceeds limit");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  let value: any;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw Error(
      `Research brief: non-JSON MCP response (HTTP ${response.status})`,
    );
  }
  if (!response.ok || value.error || value.result?.isError) {
    const unavailable =
      value.error?.message === "Source connection unavailable";
    throw Error(
      unavailable
        ? `Research brief: MCP source connection unavailable (HTTP ${response.status}); verify current credential, Roles binding and source connection before retrying`
        : `Research brief: MCP request rejected (HTTP ${response.status}, code ${Number.isInteger(value.error?.code) ? value.error.code : "unknown"})`,
    );
  }
  const brief = value.result?.structuredContent?.brief;
  if (!brief || brief.allowTasks !== true)
    throw Error("Research brief: CRM did not authorize linked tasks");
  if (
    !Array.isArray(brief.sourceDomains) ||
    brief.sourceDomains.some((x: unknown) => typeof x !== "string")
  )
    throw Error("Research brief: invalid source-domain scope");
  if (host && !brief.sourceDomains.includes(host))
    throw Error("Research brief: supplier domain is outside approved scope");
  return brief;
}
