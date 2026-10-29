import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Vault } from "../../modules/storage/vault.js";
import { EnrollmentControl } from "../../modules/task-sync/enrollment-control.js";
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
  try {
    const url = await control.listen();
    return {
      environment: {
        BITTREES_WORKFLOW_SETUP_URL: url,
        BITTREES_WORKFLOW_SETUP_TOKEN: token,
      },
      async close() {
        actions.close();
        await control.close();
      },
    };
  } catch (error) {
    actions.close();
    await control.close();
    throw error;
  }
}
