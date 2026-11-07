import { TaskSyncNativeHTTPS } from "./native-runtime-https.js";

/** Native-only transport for the exact typed assignment gateway. No requests
 * on construction, credential discovery, redirects, or general REST proxy.
 * The native owner must supply current exact-wire authority and cost admission.
 * Credential headers are deliberately excluded from the admission projection. */
export class AssignmentNativeHTTPS extends TaskSyncNativeHTTPS {
  constructor(
    admit: ConstructorParameters<typeof TaskSyncNativeHTTPS>[0],
    resolve?: ConstructorParameters<typeof TaskSyncNativeHTTPS>[1],
    send?: ConstructorParameters<typeof TaskSyncNativeHTTPS>[2],
  ) {
    super(admit, resolve, send, "crm-assignment");
  }
}

/** Decision attestation only, on the separately approved native control route.
 * No enrollment, owner handoff, activation or arbitrary coordinator action. */
export class AssignmentAttestationHTTPS extends TaskSyncNativeHTTPS {
  constructor(
    admit: ConstructorParameters<typeof TaskSyncNativeHTTPS>[0],
    resolve?: ConstructorParameters<typeof TaskSyncNativeHTTPS>[1],
    send?: ConstructorParameters<typeof TaskSyncNativeHTTPS>[2],
  ) {
    super(admit, resolve, send, "crm-assignment-attestation");
  }
}
