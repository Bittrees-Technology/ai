import { randomBytes } from "node:crypto";
import { EnrollmentConsent } from "./enrollment-consent.js";
import { EnrollmentControl } from "./enrollment-control.js";
import { EnrollmentOwner } from "./enrollment-owner.js";
import { EnrollmentBroker } from "./enrollment-broker.js";
/** Inactive native helper assembly. Trusted launcher provides source identity,
 * cost admission and encrypted-session factory; model/core supplies none of them.
 * No sockets until listen(), no session until exact native consent approval.
 */
export class EnrollmentService {
  private readonly nativeToken = randomBytes(32).toString("hex");
  private readonly coreToken = randomBytes(32).toString("hex");
  private readonly consent: EnrollmentConsent;
  private readonly control: EnrollmentControl;
  private readonly broker: EnrollmentBroker;
  private owner: EnrollmentOwner | null = null;
  private draining: Promise<void> | null = null;
  private held = false;
  private closed = false;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(
    trustedScope: () => unknown,
    costAllowed: () => boolean,
    factory: ConstructorParameters<typeof EnrollmentOwner>[3],
    now = Date.now,
  ) {
    this.consent = new EnrollmentConsent(
      trustedScope,
      costAllowed,
      () => this.stopOwner(),
      now,
      (review) => {
        if (this.closed || this.held || this.owner || this.draining)
          throw Error("Previous enrollment requires reconciliation");
        this.owner = new EnrollmentOwner(
          review,
          () => this.consent.current(),
          this.coreToken,
          factory,
          now,
        );
        this.expiry = setTimeout(
          () => this.consent.revoke(),
          Math.max(0, review.expiresAt - now()),
        );
        this.expiry.unref();
      },
    );
    this.control = new EnrollmentControl(
      this.nativeToken,
      this.coreToken,
      this.consent,
    );
    this.broker = new EnrollmentBroker(this.coreToken, () =>
      this.consent.current() ? this.owner : null,
    );
  }
  private stopOwner() {
    clearTimeout(this.expiry);
    const owner = this.owner;
    this.owner = null;
    if (!owner) return;
    owner.revoke();
    this.draining = owner
      .close()
      .catch(() => {
        this.held = true;
      })
      .finally(() => {
        this.draining = null;
      });
  }
  async listen() {
    if (this.closed) throw Error("Enrollment helper closed");
    try {
      const controlURL = await this.control.listen();
      const coreURL = await this.broker.listen();
      return {
        native: { url: controlURL, token: this.nativeToken },
        core: { url: coreURL, token: this.coreToken },
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close() {
    this.closed = true;
    this.consent.revoke();
    await this.control.close();
    await this.broker.close();
    await this.draining;
    if (this.held)
      throw Error("Enrollment storage close requires reconciliation");
  }
}
