import { z } from "zod";

/** Bound the actual streamed bytes, including replies without Content-Length.
 * Keep the caller's deadline active until the response is fully consumed.
 */
export async function centralWorkflowResponse(
  response: Response,
  requestId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Missing workflow response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(signal.reason ?? Error("Workflow response cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // A rejection handler also covers aborts between successive stream reads.
  void aborted.catch(() => {});
  try {
    signal.throwIfAborted();
    if (!response.ok) throw Error("Workflow request was rejected");
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64000) throw Error("Workflow response too large");
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    const body = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.literal(requestId),
        result: z.object({
          isError: z.boolean().optional(),
          structuredContent: z.unknown(),
        }),
        error: z.unknown().optional(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (
      body.error !== undefined ||
      body.result.isError === true ||
      body.result.structuredContent === undefined
    )
      throw Error("Workflow permission or operation was rejected");
    return body.result.structuredContent;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // A hostile or stalled source must not keep cancellation itself pending.
    void reader.cancel().catch(() => {});
  }
}
