import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { z } from "zod";
import { publicIPv4 } from "./public-pages.js";
import { cdDeviceRegistrationRequest } from "./cd-device-registration-native.js";
import { canonical } from "../contracts/canonical-json.js";

const origin = "https://roles.bittrees.org";
const prepareEndpoint = origin + "/api/profile/mcp/devices/prepare";
const packetSchema = z.strictObject({
  request: cdDeviceRegistrationRequest,
  challenge: z.string().min(1).max(5000),
  registered: z.literal(false),
  permissionsGranted: z.literal(false),
});
const selectionSchema = z.strictObject({
  principal: cdDeviceRegistrationRequest.shape.principal,
  credentialId: cdDeviceRegistrationRequest.shape.credentialId,
  label: cdDeviceRegistrationRequest.shape.label,
});
type NativeSession = {
  cookieValue: string;
  authenticatedAt: number;
  expiresAt: number;
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only a trusted native authentication owner may supply this capability.
 * It contains no caller-selected profile, owner, key or actor mapping. The
 * original authentication clock must come from that actual login ceremony. */
export type CanonicalNativeRolesSession = () => NativeSession | null;

export class CDRolesPrepareTransport {
  private packet?: z.infer<typeof packetSchema>;

  private epoch?: string;
  private freshUntil = 0;
  private resolving = false;
  private readonly optedIn: boolean;
  private selection: z.infer<typeof selectionSchema>;
  constructor(
    private options: {
      enabled?: boolean;
      selection: z.infer<typeof selectionSchema>;
      session: CanonicalNativeRolesSession;
      admitted: () => boolean;
      resolve?: typeof lookup;
      send?: typeof request;
      now?: () => number;
    },
  ) {
    this.optedIn = options.enabled === true;
    this.selection = selectionSchema.parse(options.selection);
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private currentSession() {
    if (!this.optedIn || !this.options.admitted())
      throw Error("Native CD Roles transport disabled or unapproved");
    const session = this.options.session(),
      at = this.now();
    if (
      !session ||
      !/^[a-f0-9]{64}$/.test(session.cookieValue) ||
      !Number.isSafeInteger(session.authenticatedAt) ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.authenticatedAt > at ||
      session.authenticatedAt < at - 600000 ||
      session.expiresAt <= at
    )
      throw Error("Fresh canonical native Roles session unavailable");
    return session;
  }
  private epochOf(session: NativeSession) {
    return sha(canonical(session));
  }
  private async json(signal: AbortSignal) {
    const session = this.currentSession(),
      epoch = this.epochOf(session);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const url = new URL(prepareEndpoint);
    if (this.resolving) throw Error("Prior native Roles DNS lookup is pending");
    this.resolving = true;
    const pending = Promise.resolve()
      .then(() =>
        (this.options.resolve ?? lookup)(url.hostname, {
          all: true,
          family: 4,
        }),
      )
      .finally(() => {
        this.resolving = false;
      });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(bounded.reason ?? Error("Native Roles DNS cancelled"));
      bounded.addEventListener("abort", onAbort, { once: true });
    });
    let addresses: Awaited<typeof pending>;
    try {
      bounded.throwIfAborted();
      addresses = await Promise.race([pending, aborted]);
    } finally {
      if (onAbort) bounded.removeEventListener("abort", onAbort);
    }
    bounded.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some((address) => !publicIPv4(address.address))
    )
      throw Error("Native Roles public address required");
    if (this.epochOf(this.currentSession()) !== epoch)
      throw Error("Native Roles session changed");
    const encoded = JSON.stringify(this.selection);
    return new Promise<unknown>((resolve, reject) => {
      const req = (this.options.send ?? request)(
        url,
        {
          method: "POST",
          signal: bounded,
          family: 4,
          agent: false,
          rejectUnauthorized: true,
          servername: "roles.bittrees.org",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "identity",
            Origin: origin,
            Cookie: "__Host-roles=" + session.cookieValue,
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(encoded)),
          },
          lookup: ((
            _host: unknown,
            opts: { all?: boolean },
            callback: Function,
          ) =>
            opts.all
              ? callback(null, [addresses[0]!])
              : callback(null, addresses[0]!.address, 4)) as never,
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !/^application\/json(?:;|$)/i.test(
              String(response.headers["content-type"] ?? ""),
            ) ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity")
          ) {
            response.destroy();
            reject(Error("Canonical Roles response rejected"));
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 64000)
              response.destroy(Error("Canonical Roles response too large"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("aborted", () =>
            reject(Error("Canonical Roles response interrupted")),
          );
          response.on("end", () => {
            try {
              bounded.throwIfAborted();
              if (this.epochOf(this.currentSession()) !== epoch)
                throw Error("Native Roles session changed");
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(encoded);
    });
  }
  private checkPacket(raw: unknown) {
    const packet = packetSchema.parse(raw),
      request = packet.request;
    if (
      request.principal !== this.selection.principal ||
      request.credentialId !== this.selection.credentialId ||
      request.label !== this.selection.label ||
      request.issuedAt > this.now() ||
      request.expiresAt <= this.now() ||
      request.expiresAt <= request.issuedAt ||
      request.expiresAt > request.issuedAt + 60000
    )
      throw Error("Canonical Roles preparation binding mismatch");
    return packet;
  }
  async prepare(signal: AbortSignal) {
    this.revoke();
    const epoch = this.epochOf(this.currentSession());
    const packet = this.checkPacket(await this.json(signal));
    if (epoch !== this.epochOf(this.currentSession()))
      throw Error("Native Roles session changed");
    this.packet = packet;
    this.epoch = epoch;
    this.freshUntil = Math.min(this.now() + 5000, packet.request.expiresAt);
    return structuredClone(packet);
  }
  async refresh(signal: AbortSignal) {
    const packet = this.packet,
      epoch = this.epoch;
    if (!packet || packet.request.expiresAt <= this.now())
      throw Error("Native CD review expired");
    const probe = this.checkPacket(await this.json(signal));
    for (const field of [
      "ownerProfile",
      "principal",
      "credentialId",
      "label",
      "sessionBinding",
    ] as const) {
      if (probe.request[field] !== packet.request[field])
        throw Error("Canonical Roles ownership changed");
    }
    if (
      epoch !== this.epochOf(this.currentSession()) ||
      this.packet !== packet ||
      packet.request.expiresAt <= this.now()
    )
      throw Error("Native Roles review changed");
    // Probe request/device IDs and sealed challenge are discarded. They never
    // replace the original approved packet or extend its original lifetime.
    this.freshUntil = Math.min(
      this.now() + 5000,
      packet.request.expiresAt,
      probe.request.expiresAt,
    );
  }
  currentOwner = () => {
    try {
      const session = this.currentSession(),
        packet = this.packet;
      if (
        !packet ||
        this.epoch !== this.epochOf(session) ||
        this.now() >= this.freshUntil ||
        packet.request.expiresAt <= this.now()
      )
        return null;
      return {
        ownerProfile: packet.request.ownerProfile,
        principal: packet.request.principal,
        credentialId: packet.request.credentialId,
        sessionBinding: packet.request.sessionBinding,
        enrolled: true as const,
        credentialKind: "non-lease" as const,
        preparedPacketDigest: sha(canonical(packet)),
        preparedEndpoint:
          prepareEndpoint as "https://roles.bittrees.org/api/profile/mcp/devices/prepare",
        authenticatedAt: session.authenticatedAt,
        sessionExpiresAt: session.expiresAt,
      };
    } catch {
      return null;
    }
  };
  revoke() {
    this.packet = undefined;

    this.epoch = undefined;
    this.freshUntil = 0;
  }
}
