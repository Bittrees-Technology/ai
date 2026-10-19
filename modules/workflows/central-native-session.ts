import { isAbsolute } from "node:path";
import { Vault } from "../storage/vault.js";
import { CentralTransportPlan } from "./central-transport-plan.js";
import { CentralTransportBudget } from "./central-transport-budget.js";
import { CentralNativeHTTPS } from "./central-native-https.js";
import {
  centralNativeReviewSchema,
  type CentralNativeReview,
} from "./central-native-owner.js";
/** Native-only assembly, called after exact consent. The launcher must verify
 * current source/cost evidence; a review file is not proof of either. Credentials
 * remain native-owned and are not read until an admitted HTTPS dispatch.
 */
export function nativeCentralSessionFactory(options: {
  path: string;
  vault: Vault;
  credential: () => string;
  admitted: () => boolean;
  now?: () => number;
}) {
  if (!isAbsolute(options.path))
    throw Error("Absolute native budget path required");
  const now = options.now ?? Date.now;
  return (current: () => CentralNativeReview | null) => {
    const admitted = () => {
      if (!options.admitted())
        throw Error("Current source/cost admission required");
      return centralNativeReviewSchema.parse(current());
    };
    admitted();
    const plan = new CentralTransportPlan(() => admitted().scope, now);
    const budget = new CentralTransportBudget(
      options.path,
      options.vault,
      () => admitted().budget,
      () => plan.assertCurrent(),
      now,
    );
    try {
      const transport = new CentralNativeHTTPS(plan, budget.reserve, () => {
        admitted();
        return options.credential();
      });
      return { dispatch: transport.dispatch, close: () => budget.close() };
    } catch (error) {
      budget.close();
      throw error;
    }
  };
}
