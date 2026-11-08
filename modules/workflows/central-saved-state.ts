import Database from "better-sqlite3";
import {
  createHash,
  createPublicKey,
  createPrivateKey,
  sign,
} from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { assignmentAuthorityRequest } from "../task-sync/assignment-proof-contract.js";
import { canonical } from "../contracts/canonical-json.js";
import { finitePilotReviewSchema } from "./central-finite-pilot.js";
const identitySchema = z.strictObject({
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  publicKey: z.string().max(512),
  privateKey: z.string().max(4096),
  credentialId: z.string().regex(/^[a-f0-9]{64}$/),
});
const configurationSchema = z.strictObject({
  confirmed: z.literal(true),
  enabled: z.boolean(),
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
  connectionId: z.uuid(),
  workflowId: z.string().min(1).max(128),
  delegationId: z.uuid(),
  profileId: z.uuid(),
  mcpToken: z.string().regex(/^[\x21-\x7e]{16,4096}$/),
  finitePilot: finitePilotReviewSchema.optional(),
});
function read(
  path: string,
  vault: Vault,
  decision?: z.infer<typeof assignmentAuthorityRequest>,
  now = Date.now(),
) {
  if (!isAbsolute(path) || realpathSync(path) !== path)
    throw Error("Canonical existing central state path required");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw Error("Regular existing central state required");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const value = (name: string) => {
        const row = db
          .prepare("SELECT value FROM state WHERE key=?")
          .get(name) as { value: Buffer } | undefined;
        if (!row)
          throw Error("Existing central identity/configuration required");
        return vault.open<unknown>(row.value, "central-workflows:" + name);
      };
      const identity = identitySchema.parse(value("identity")),
        config = configurationSchema.parse(value("config"));
      z.uuid().parse(identity.principal.slice(6));
      const publicKey = createPublicKey(identity.publicKey),
        privateKey = createPrivateKey(identity.privateKey);
      if (
        publicKey.asymmetricKeyType !== "ed25519" ||
        privateKey.asymmetricKeyType !== "ed25519" ||
        publicKey.export({ format: "pem", type: "spki" }) !==
          identity.publicKey ||
        createPublicKey(privateKey).export({ format: "pem", type: "spki" }) !==
          identity.publicKey ||
        createHash("sha256").update(identity.publicKey).digest("hex") !==
          identity.credentialId
      )
        throw Error("Saved central signing identity is inconsistent");
      let signature: string | undefined;
      if (decision) {
        if (
          decision.principal !== identity.principal ||
          decision.credentialId !== identity.credentialId ||
          decision.tenant !== config.tenant ||
          decision.workspace !== config.workspace ||
          decision.resource !== "workflow:" + config.workflowId ||
          decision.issuedAt > now + 1000 ||
          decision.issuedAt < now - 15000
        )
          throw Error("Existing central assignment signing scope changed");
        signature = sign(
          null,
          Buffer.from(
            "Bittrees MCP authority request v1\n" + canonical(decision),
          ),
          privateKey,
        ).toString("base64");
      }
      const after = lstatSync(path);
      if (
        after.isSymbolicLink() ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        realpathSync(path) !== path
      )
        throw Error("Central state path changed during read");
      return {
        snapshot: {
          principal: identity.principal,
          publicKey: identity.publicKey,
          credentialId: identity.credentialId,
          tenant: config.tenant,
          workspace: config.workspace,
          connectionId: config.connectionId,
          workflowId: config.workflowId,
          delegationId: config.delegationId,
          profileId: config.profileId,
          ...(config.finitePilot ? { finitePilot: config.finitePilot } : {}),
          mcpCredentialDigest: createHash("sha256")
            .update(config.mcpToken)
            .digest("hex"),
        },
        token: config.mcpToken,
        ...(signature ? { signature } : {}),
      };
    })();
  } finally {
    db.close();
  }
}
/** Read-only existing public identity/configuration; no key creation, Keychain,
 * private-key return, source requests or authority claims. Pause/resume state is
 * deliberately outside this binding; source/profile/credential changes are not.
 */
export function savedCentralState(path: string, vault: Vault) {
  return Object.freeze(read(path, vault).snapshot);
}
/** Native-only existing credential reader; no fallback or credential creation. */
export function existingCentralCredential(path: string, vault: Vault) {
  return read(path, vault).token;
}

/** Native-only decision signer. Uses the existing central key in its own vault;
 * returns only a signature, never enrolls, creates or exports a signing key. */
export function signExistingCentralAssignmentRequest(
  path: string,
  vault: Vault,
  raw: unknown,
  now = Date.now(),
) {
  const request = assignmentAuthorityRequest.parse(raw);
  return read(path, vault, request, now).signature!;
}
