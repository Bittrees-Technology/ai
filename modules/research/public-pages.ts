import { lookup } from "node:dns/promises";
import { get } from "node:https";
import { isIP } from "node:net";
export function publicIPv4(ip: string) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return !(
    [0, 10, 127].includes(a) ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
export function sourceURL(value: string, hosts: string[]) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !hosts.includes(u.hostname) ||
    isIP(u.hostname)
  )
    throw new Error("Source host is not approved");
  u.hash = "";
  return u;
}
export const decode = (s: string) =>
  s
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const c =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : " ";
    })
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
export function pageText(html: string) {
  return decode(
    html
      .replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
export async function publicPage(
  raw: string,
  hosts: string[],
  signal: AbortSignal,
  redirects = 0,
): Promise<{ url: string; text: string; links: string[] }> {
  const url = sourceURL(raw, hosts);
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
    throw new Error("Source address is not public");
  const address = addresses[0]!;
  const response = await new Promise<{
    status: number;
    location?: string;
    type: string;
    html: string;
  }>((resolve, reject) => {
    const req = get(
      url,
      {
        signal,
        family: 4,
        headers: {
          "User-Agent": "BittreesResearch/1.0 (public investor research)",
          Accept: "text/html,text/plain",
          "Accept-Encoding": "identity",
        },
        lookup: ((_host: any, _options: any, cb: any) =>
          _options.all
            ? cb(null, [{ address: address.address, family: 4 }])
            : cb(null, address.address, 4)) as any,
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1_000_000) {
            res.destroy(new Error("Source exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            location: res.headers.location,
            type: String(res.headers["content-type"] || ""),
            html: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
  });
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.location &&
    redirects < 3
  )
    return publicPage(
      new URL(response.location, url).href,
      hosts,
      signal,
      redirects + 1,
    );
  if (response.status !== 200 || !/text\/(html|plain)/i.test(response.type))
    throw new Error("Source unavailable or unsupported");
  const links = [
    ...response.html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi),
  ].flatMap((m) => {
    try {
      const u = sourceURL(new URL(decode(m[1]!), url).href, hosts);
      return /team|people|leadership|professionals|partners|about|contact|location|investments|strategies|philosophy/i.test(
        u.pathname,
      )
        ? [u.href]
        : [];
    } catch {
      return [];
    }
  });
  return {
    url: url.href,
    text: pageText(response.html),
    links: [...new Set(links)].slice(0, 30),
  };
}
