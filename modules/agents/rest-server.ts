import express from "express";
import { agentMessage } from "./rest.js";
/** Mount only behind real TLS. Never trusts forwarded headers or pairing cookies as agent authority. */
export function agentRestRouter(options: {
  authorize: (
    bearer: string,
    message: ReturnType<typeof agentMessage.parse>,
  ) => Promise<boolean>;
  submit: (
    message: ReturnType<typeof agentMessage.parse>,
  ) => Promise<{ operationId: string; state: "queued" | "held" }>;
}) {
  const router = express.Router();
  router.post(
    "/v1/agent-tasks",
    express.json({ limit: "16kb" }),
    async (req, res) => {
      if (!(req.socket as { encrypted?: boolean }).encrypted) {
        res.status(403).json({ error: "TLS required" });
        return;
      }
      const parsed = agentMessage.safeParse(req.body);
      const header = req.get("authorization") ?? "";
      if (
        !parsed.success ||
        !/^Bearer [^\s]{16,4096}$/.test(header) ||
        req.get("idempotency-key") !== parsed.data.operationId
      ) {
        res.status(400).json({ error: "Invalid agent envelope" });
        return;
      }
      if (!(await options.authorize(header.slice(7), parsed.data))) {
        res.status(403).json({ error: "Current scoped delegation required" });
        return;
      }
      // submit must persist operation ID idempotently and reauthorize at actual execution.
      const result = await options.submit(parsed.data);
      if (result.operationId !== parsed.data.operationId)
        throw Error("Mismatched operation receipt");
      res.status(202).json(result);
    },
  );
  return router;
}
