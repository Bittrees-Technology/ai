import { createHash } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
import { EnrollmentTransportPlan, enrollmentOperation } from "./enrollment-transport-plan.js";
import { EnrollmentJournal, type EnrollmentOperationBinding } from "./enrollment-journal.js";
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
type Plan = ReturnType<EnrollmentTransportPlan["prepare"]>;
/** Inactive transport seam, not an HTTPS implementation. Dispatch and receipt verification
 * must be supplied by reviewed native code; neither may be selected by model output.
 * No automatic retry. Unknown mutations stay reserved even when the caller cancels.
 */
export class EnrollmentExchange {
  private busy = false;
  constructor(
    private planner: EnrollmentTransportPlan,
    private journal: EnrollmentJournal,
    private dispatch: (plan: Plan, signal: AbortSignal) => Promise<Uint8Array>,
    private verify: (operation: ReturnType<typeof enrollmentOperation.parse>, response: unknown) => void | Promise<void>,
  ) {}
  async execute(raw: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.busy) throw Error("Enrollment exchange already active");
    signal.throwIfAborted();
    const operation = enrollmentOperation.parse(raw);
    const plan = this.planner.prepare(operation);
    this.busy = true;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(Error("Enrollment request deadline")), plan.timeoutMs);
    let binding: EnrollmentOperationBinding | undefined;
    try {
      this.planner.assertCurrent();
      controller.signal.throwIfAborted();
      if (operation.operation === "start" || operation.operation === "complete") {
        // One durable mutation identity per reviewed epoch and operation kind.
        // Changing nonce/body cannot mint a fresh retry after an unknown outcome.
        const id = hash({ epoch: plan.epoch, kind: operation.operation });
        binding = { operationId: `${id.slice(0,8)}-${id.slice(8,12)}-4${id.slice(13,16)}-a${id.slice(17,20)}-${id.slice(20,32)}`,
          epoch: plan.epoch, kind: operation.operation, requestDigest: hash(plan.body) };
        this.journal.reserve(binding);
      }
      this.planner.assertCurrent();
      const bytes = await this.dispatch(plan, controller.signal);
      controller.signal.throwIfAborted();
      this.planner.assertCurrent();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > plan.maximumResponseBytes)
        throw Error("Enrollment response limit exceeded");
      const response: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      await this.verify(operation, response);
      controller.signal.throwIfAborted();
      this.planner.assertCurrent();
      if (binding) this.journal.confirm(binding, hash(response));
      return response;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.busy = false;
    }
  }
}
