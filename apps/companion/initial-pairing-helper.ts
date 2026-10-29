import { randomBytes } from "node:crypto";
import { NativeInitialPairingSession } from "../../modules/task-sync/initial-pairing-native-session.js";
import { NativeInitialPairingReviewActions } from "../../modules/task-sync/initial-pairing-native-review.js";
import { InitialPairingNativeControl } from "../../modules/task-sync/initial-pairing-native-control.js";
import { requireSynchronousPairingAdmission } from "../../modules/task-sync/initial-pairing-admission.js";
import type { InitialPairingConsent } from "../../modules/task-sync/initial-pairing.js";

type SessionOptions = ConstructorParameters<
  typeof NativeInitialPairingSession
>[0];
type Binding = Pick<
  ReturnType<NativeInitialPairingSession["reviewBinding"]>,
  "principal" | "keyFingerprint" | "rolesKeyFingerprint"
>;

/** Inactive assembly: no running launcher imports this factory. A future trusted
 * native owner supplies separately inspected public identity, already unlocked
 * Vault, owned paths and independently reviewed source/cost configuration.
 * It must never forward the returned native capability to the model or browser.
 * No key creation, automatic start/poll, grant, wallet or runtime enrollment.
 */
export function prepareNativeInitialPairingHelper(options: {
  identity: SessionOptions["identity"];
  rolesPublicKey: string;
  vault: SessionOptions["vault"];
  taskStatePath: string;
  journalPath: string;
  coreToken: string;
  currentBinding: () => Binding | null;
  admitSource: (scope: {
    purpose: "metadata-only-owner-pairing";
    rolesKeyFingerprint: string;
    additionalSpendingUSD: 0;
  }) => void;
  // Trusted synthetic acceptance injection only, never loaded from configuration,
  // environment, IPC inputs, model output or a source response.
  network?: SessionOptions["network"];
}) {
  let consent: () => InitialPairingConsent | null = () => null;
  let expected: ReturnType<NativeInitialPairingSession["reviewBinding"]>;
  const assertBinding = () => {
    const actual = options.currentBinding();
    if (
      !actual ||
      actual.principal !== expected.principal ||
      actual.keyFingerprint !== expected.keyFingerprint ||
      actual.rolesKeyFingerprint !== expected.rolesKeyFingerprint
    )
      throw Error(
        "Current independently remembered native/source binding required",
      );
  };
  const admit = () => {
    assertBinding();
    requireSynchronousPairingAdmission(() =>
      options.admitSource({
        purpose: "metadata-only-owner-pairing",
        rolesKeyFingerprint: expected.rolesKeyFingerprint,
        additionalSpendingUSD: 0,
      }),
    );
    assertBinding();
  };
  const session = new NativeInitialPairingSession({
    identity: { ...options.identity },
    rolesPublicKey: options.rolesPublicKey,
    vault: options.vault,
    taskStatePath: options.taskStatePath,
    journalPath: options.journalPath,
    currentConsent: () => consent(),
    admitSource: admit,
    network: options.network,
  });
  expected = Object.freeze(session.reviewBinding());
  assertBinding();
  const review = new NativeInitialPairingReviewActions({
    identity: { ...options.identity },
    rolesPublicKey: options.rolesPublicKey,
    admitSource: admit,
    createSession(currentConsent) {
      assertBinding();
      consent = currentConsent;
      return session;
    },
  });
  let token: string;
  do {
    token = randomBytes(32).toString("hex");
  } while (token === options.coreToken);
  const control = new InitialPairingNativeControl(token, options.coreToken, {
    prepare() {
      assertBinding();
      return review.prepare();
    },
    approve: (confirmation) => review.approve(confirmation),
    poll: () => review.poll(),
    async close() {
      try {
        await review.close();
      } finally {
        await session.close();
      }
    },
  });
  return {
    async listen() {
      try {
        const endpoint = await control.listen();
        assertBinding();
        return { endpoint, token, binding: { ...expected } };
      } catch (error) {
        await control.close();
        throw error;
      }
    },
    close: () => control.close(),
  };
}
