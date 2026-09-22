/** One bounded request, including response-body consumption. Never retries a write. */
export function createLocalApi(
  fetcher: typeof fetch = fetch,
  timeoutMs = 15000,
) {
  return async function api(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetcher(path, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (response.status === 204 && response.ok) return null;
      let data: any;
      try {
        data = await response.json();
      } catch {
        if (signal.aborted) throw Error("LOCAL_TIMEOUT");
        throw Error("LOCAL_INVALID_RESPONSE");
      }
      if (!response.ok) {
        if (
          typeof data?.error !== "string" ||
          !/^[A-Z][A-Z0-9_]{0,63}$/.test(data.error)
        )
          throw Error("LOCAL_INVALID_RESPONSE");
        throw Error(data.error);
      }
      return data;
    } catch (error) {
      if (signal.aborted) throw Error("LOCAL_TIMEOUT");
      if (error instanceof TypeError) throw Error("LOCAL_UNAVAILABLE");
      throw error;
    }
  };
}
