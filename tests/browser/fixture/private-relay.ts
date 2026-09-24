import {
  PrivateRelayClient,
  PrivateRelayOwnerClient,
  BrowserRelayPermissionsClient,
  type PrivateRelayClientContext,
} from "../../../modules/remote/private-relay-client.js";
let owner: string | null = null,
  context: PrivateRelayClientContext | null = null,
  client: PrivateRelayClient,
  history: PrivateRelayOwnerClient,
  permissions: BrowserRelayPermissionsClient,
  scope = 0,
  result = "idle";
async function api(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Bittrees-Request": "1",
      ...(owner ? { "X-Bittrees-Account": owner } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error("DENIED");
  return r.json();
}
const fixture = {
  challenge: (address: string) => api("/browser/login/challenge", { address }),
  async login(message: string, signature: string) {
    const login = await api("/browser/login/verify", { message, signature });
    owner = login.ownerId;
    scope++;
    const registered = await api("/browser/registration/create", {
      operationId: crypto.randomUUID(),
      expected: null,
      confirmed: true,
    });
    permissions = new BrowserRelayPermissionsClient(() =>
      owner ? { ownerId: owner, scope: String(scope) } : null,
    );
    const grant = await permissions.enableBrowser({
      deviceId: registered.binding.deviceId,
      credentialEpoch: registered.binding.credentialEpoch,
      operationId: crypto.randomUUID(),
      expected: null,
      expiresAt: Date.now() + 600000,
      confirmed: true,
    });
    context = {
      kind: "browser",
      scope: String(scope),
      identity: {
        version: 1,
        scope: "private:relay",
        ownerId: owner!,
        endpointId: registered.binding.deviceId,
        endpointKind: "browser",
        credentialEpoch: registered.binding.credentialEpoch,
        permissionId: grant.id,
        expiresAt: grant.expiresAt,
      },
    };
    client = new PrivateRelayClient(() => context);
    history = new PrivateRelayOwnerClient(() =>
      owner ? { ownerId: owner, scope: String(scope) } : null,
    );
    return { ownerId: owner!, binding: registered.binding, grant };
  },
  approve: (deviceId: string, epoch: number) =>
    permissions.approveMac({
      operationId: crypto.randomUUID(),
      expected: null,
      expiresAt: Date.now() + 600000,
      confirmed: true,
      deviceId,
      credentialEpoch: epoch,
    }),
  endpoint: (raw: unknown) => permissions.inspectEndpoint(raw),
  operation: (id: string) => permissions.inspectOperation(id),
  listPermissions: (after: string | null = null) =>
    permissions.list({ after, limit: 1 }),
  revokePermission: (raw: unknown) => permissions.revoke(raw),
  permission: (id: string) => permissions.inspect(id),
  startEndpoint(raw: unknown) {
    result = "pending";
    void permissions.inspectEndpoint(raw).then(
      () => {
        result = "accepted";
      },
      (e) => {
        result = e.message;
      },
    );
  },
  submit: (envelope: unknown) => client.submit({ version: 1, envelope }),
  poll: () => client.poll({ after: null, limit: 20 }),
  acknowledge: (raw: unknown) => client.acknowledge(raw),
  export: () => history.export({ after: null, limit: 20 }),
  replace: (id: string, revision: number) =>
    permissions.enableBrowser({
      deviceId: context?.identity.endpointId,
      credentialEpoch: context?.identity.credentialEpoch,
      operationId: crypto.randomUUID(),
      expected: { id, revision },
      expiresAt: Date.now() + 600000,
      confirmed: true,
    }),
  startInspect(messageId: string) {
    result = "pending";
    void client.inspect({ messageId }).then(
      () => {
        result = "accepted";
      },
      (e) => {
        result = e.message;
      },
    );
  },
  invalidate() {
    client.invalidate();
    permissions.invalidate();
    context = null;
    scope++;
  },
  result: () => result,
};
declare global {
  interface Window {
    privateRelayTest: typeof fixture;
  }
}
window.privateRelayTest = fixture;
