import { ProtectedLoopbackClient } from "../task-sync/enrollment-client.js";
import {
  centralEnrollmentCommand,
  centralEnrollmentStatus,
} from "./central-enrollment-contract.js";
/** Core gets typed start/poll/status only, no request/signing/secret controls. */
export class CentralEnrollmentClient extends ProtectedLoopbackClient {
  constructor(endpoint: string, token: string) {
    super(endpoint, token, {
      path: "/central-enrollment",
      parse: (raw) => centralEnrollmentCommand.parse(raw),
      maxRequest: 2048,
      maxResponse: 64000,
      deadline: 50000,
    });
  }
  override async execute(raw: unknown, signal: AbortSignal) {
    return centralEnrollmentStatus.parse(await super.execute(raw, signal));
  }
}
export function nativeCentralEnrollmentClient(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.BITTREES_ENROLLMENT_PURPOSE !== "central-workflows")
    return undefined;
  const endpoint = environment.BITTREES_ENROLLMENT_HELPER_URL,
    token = environment.BITTREES_ENROLLMENT_HELPER_TOKEN;
  if (!endpoint || !token)
    throw Error("Incomplete native central enrollment capability");
  return new CentralEnrollmentClient(endpoint, token);
}
