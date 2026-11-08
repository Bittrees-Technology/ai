import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  centralGatewayReviewActions,
  readCompletedCentralEnrollment,
  prepareCentralGatewayCredential,
  readPreparedCentralGatewayReceipt,
} from "../../modules/workflows/central-gateway-credential.js";
import type { Vault } from "../../modules/storage/vault.js";
import { EnrollmentControl } from "../../modules/task-sync/enrollment-control.js";
import {
  centralIdentityReviewActions,
  readCentralIdentity,
} from "../../modules/workflows/central-identity-review.js";
import {
  nativeIdentityReviewActions,
  readNativeWorkflowIdentity,
  initializeNativeWorkflowIdentity,
} from "../../modules/task-sync/native-identity-review.js";

/** Local-only native inspection is available without enrollment configuration.
 * The vault is unlocked only after an explicit native owner review request.
 * The returned capability must never reach the model/core or web content. */
export async function launchWorkflowSetup(
  directory: string,
  unlock: () => Promise<Vault>,
  now = Date.now,
) {
  const token = randomBytes(32).toString("hex"),
    unusedCoreToken = randomBytes(32).toString("hex");
  const path = join(directory, "task-sync.db");
  const actions = nativeIdentityReviewActions(
    async () => readNativeWorkflowIdentity(path, await unlock()),
    now,
    async (admitted) =>
      initializeNativeWorkflowIdentity(path, await unlock(), admitted),
  );
  const control = new EnrollmentControl(token, unusedCoreToken, actions);
  const centralToken = randomBytes(32).toString("hex");
  const centralActions = centralIdentityReviewActions(
    async () =>
      readCentralIdentity(
        join(directory, "central-workflows.db"),
        await unlock(),
      ),
    now,
  );
  const centralControl = new EnrollmentControl(
    centralToken,
    unusedCoreToken,
    centralActions,
  );
  const gatewayToken = randomBytes(32).toString("hex");
  const gatewayActions = centralGatewayReviewActions(
    async () => readCompletedCentralEnrollment(directory, await unlock()),
    async (e, admitted) =>
      prepareCentralGatewayCredential(
        directory,
        await unlock(),
        e,
        admitted,
        now,
      ),
    now,
    async () => {
      try {
        return readPreparedCentralGatewayReceipt(directory, await unlock());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
  );
  const gatewayControl = new EnrollmentControl(
    gatewayToken,
    unusedCoreToken,
    gatewayActions,
  );
  try {
    const url = await control.listen();
    const centralUrl = await centralControl.listen();
    const gatewayUrl = await gatewayControl.listen();
    return {
      environment: {
        BITTREES_WORKFLOW_SETUP_URL: url,
        BITTREES_WORKFLOW_SETUP_TOKEN: token,
        BITTREES_CENTRAL_IDENTITY_URL: centralUrl,
        BITTREES_CENTRAL_IDENTITY_TOKEN: centralToken,
        BITTREES_CENTRAL_GATEWAY_SETUP_URL: gatewayUrl,
        BITTREES_CENTRAL_GATEWAY_SETUP_TOKEN: gatewayToken,
      },
      async close() {
        actions.close();
        centralActions.close();
        gatewayActions.close();
        await gatewayControl.close();
        await centralControl.close();
        await control.close();
      },
    };
  } catch (error) {
    actions.close();
    centralActions.close();
    gatewayActions.close();
    await gatewayControl.close();
    await centralControl.close();
    await control.close();
    throw error;
  }
}
