import type { Express, Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { RemotePrivateRelayAccess } from "./private-relay-access.js";
import { RemotePrivateRelayStore } from "./private-relay-store.js";
import { RemoteStatusError } from "./status-store.js";
import { privateRelayPolicySchema } from "./private-relay-contracts.js";

/** Called only after an explicit matching host policy, beneath direct TLS,
 * host/CSRF/header, rate and body limits. Does not migrate, listen or schedule. */
export function mountPrivateRelayRoutes(
  app: Express,
  pool: Pool,
  policy: z.infer<typeof privateRelayPolicySchema>,
  now: () => number,
  auth: {
    browserAuthority: (req: Request) => { session: string; account: string };
    browserCredential: (req: Request) => string | null;
    token: (req: Request) => string;
  },
) {
  const access = new RemotePrivateRelayAccess(
    pool,
    policy.origin,
    policy.chainId,
    now,
  );
  const store = new RemotePrivateRelayStore(pool, policy, now);
  const endpointStore = (req: Request) => {
    const id = req.headers["x-bittrees-relay-permission"];
    if (typeof id !== "string" || !z.uuid().safeParse(id).success)
      throw new RemoteStatusError("DENIED");
    return new RemotePrivateRelayStore(pool, policy, now, id);
  };
  const empty = (raw: unknown) => {
    if (!z.strictObject({}).safeParse(raw).success)
      throw new RemoteStatusError("INVALID_INPUT");
  };
  const browser = (req: Request) => {
    const { session, account } = auth.browserAuthority(req),
      credential = auth.browserCredential(req);
    if (!credential) throw new RemoteStatusError("DENIED");
    return [session, account, credential] as const;
  };
  app.post("/browser/relay/permission/inspect", async (req, res) => {
    empty(req.body);
    res.json(await access.inspectBrowser(...browser(req)));
  });
  app.post("/browser/relay/permission/enable", async (req, res) =>
    res.json(await access.enableBrowser(...browser(req), req.body)),
  );
  app.post("/browser/relay/mac/approve", async (req, res) => {
    const { session, account } = auth.browserAuthority(req);
    res.json(await access.approveMac(session, account, req.body));
  });
  const ownerPermission = {
    inspect: access.inspectOwner.bind(access),
    operation: access.inspectOwnerOperation.bind(access),
    list: access.listOwner.bind(access),
    revoke: access.revokeOwner.bind(access),
  };
  for (const [name, method] of Object.entries(ownerPermission))
    app.post("/browser/relay/permissions/" + name, async (req, res) => {
      const { session, account } = auth.browserAuthority(req);
      res.json(await method(session, account, req.body));
    });
  app.post("/device/relay/approval/inspect", async (req, res) =>
    res.json(await access.inspectMacApproval(auth.token(req), req.body)),
  );
  app.post("/device/relay/permission/accept", async (req, res) =>
    res.json(await access.acceptMac(auth.token(req), req.body)),
  );
  app.post("/device/relay/permission/inspect", async (req, res) => {
    empty(req.body);
    res.json(await access.withMac(auth.token(req), async (c) => c.identity));
  });
  app.post("/device/relay/permission/revoke", async (req, res) =>
    res.json(await access.revokeMac(auth.token(req), req.body)),
  );
  const browserMessages = {
    submit: "submitBrowser",
    poll: "pollBrowser",
    inspect: "inspectBrowser",
    acknowledge: "acknowledgeBrowser",
    delete: "deleteBrowser",
  } as const;
  for (const [name, method] of Object.entries(browserMessages))
    app.post("/browser/relay/messages/" + name, async (req, res) =>
      res.json(await endpointStore(req)[method](...browser(req), req.body)),
    );
  const macMessages = {
    submit: "submitMac",
    poll: "pollMac",
    inspect: "inspectMac",
    acknowledge: "acknowledgeMac",
    delete: "deleteMac",
  } as const;
  for (const [name, method] of Object.entries(macMessages))
    app.post("/device/relay/messages/" + name, async (req, res) =>
      res.json(await endpointStore(req)[method](auth.token(req), req.body)),
    );
  app.post("/browser/relay/history/export", async (req, res) => {
    const { session, account } = auth.browserAuthority(req);
    res.json(await store.exportOwner(session, account, req.body));
  });
  app.post("/browser/relay/history/delete", async (req, res) => {
    const { session, account } = auth.browserAuthority(req);
    res.json(await store.deleteOwner(session, account, req.body));
  });
}
