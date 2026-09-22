/** Explicit local backup download. No retry, key export or filesystem-path input. */
export async function requestBackup(
  fetcher: typeof fetch = fetch,
  timeoutMs = 120000,
  maxBytes = 128 * 1024 * 1024,
) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetcher("/v1/backup", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
      signal,
    });
    if (!response.ok) {
      const data = await response.json();
      throw Error(
        typeof data?.error === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(data.error)
          ? data.error
          : "LOCAL_INVALID_RESPONSE",
      );
    }
    if (
      response.headers.get("Content-Type")?.split(";")[0] !==
        "application/octet-stream" ||
      !response.body
    )
      throw Error("LOCAL_INVALID_RESPONSE");
    const reader = response.body.getReader(),
      chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) throw Error("CAPACITY");
        chunks.push(Uint8Array.from(next.value));
      }
    } finally {
      await reader.cancel();
    }
    if (!size) throw Error("LOCAL_INVALID_RESPONSE");
    return new Blob(chunks, { type: "application/octet-stream" });
  } catch (error) {
    if (signal.aborted) throw Error("LOCAL_TIMEOUT");
    if (error instanceof TypeError) throw Error("LOCAL_UNAVAILABLE");
    throw error;
  }
}
