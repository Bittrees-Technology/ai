import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  setup,
  completeBrowserCheck,
  checks,
  refresh as refreshChecks,
  incoming as incomingCheck,
  confirm as confirmCheck,
  output as checkOutput,
} from "./support/browser-mac-ui.js";
import {
  openRecovery,
  refreshRegistration,
  keyControls,
} from "./support/browser-recovery-ui.js";
import { readFile, mkdir } from "node:fs/promises";
import type { PrivateEnvelope } from "../../modules/remote/private-envelope.js";
const panel = (p: Page) =>
  p.getByRole("region", { name: "Browser private tasks", exact: true });
const permission = (p: Page) =>
  p.getByRole("region", { name: "Browser task permissions", exact: true });
const text =
  "SYNTHETIC_BROWSER_TASK_TEXT — explain the supplied sentence, without app or source access.";
async function refresh(p: Page) {
  await panel(p)
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(panel(p).getByRole("status")).toContainText(
    "Task history loaded",
  );
}
async function confirm(p: Page, name: string) {
  const b = panel(p).getByRole("button", { name, exact: true });
  await expect(b).toBeDisabled();
  await expect(panel(p).getByRole("checkbox")).not.toBeChecked();
  await panel(p).getByRole("checkbox").check();
  await b.click();
}
async function initialize(p: Page) {
  await refresh(p);
  await expect(panel(p)).toContainText("Task storage is not set up");
  await panel(p)
    .getByRole("button", { name: "Review task storage setup", exact: true })
    .click();
  await expect(
    panel(p).getByRole("heading", {
      name: "Set up this browser’s task storage",
      exact: true,
    }),
  ).toBeFocused();
  await confirm(p, "Confirm task storage setup");
  await expect(panel(p).getByRole("status")).toContainText("Task change saved");
}
async function ready(p: Page) {
  const f = await setup(p, () => initialize(p));
  try {
    await completeBrowserCheck(p, f);
    const c = await f.macBegin(),
      wire = await f.mac.checks.delivery({ id: c.id, confirmed: true });
    await refreshChecks(p);
    await incomingCheck(p, wire, "answer");
    await confirmCheck(p, "Answer Mac check");
    const response = await checkOutput(p);
    await f.mac.checks.complete({ envelope: response, confirmed: true });
    const peer = f.mac.peers
      .list()
      .peers.find((x) => x.peerId === f.binding.deviceId)!;
    await f.mac.allowTasks(f.binding.deviceId, peer.keyEpoch);
    await permission(p)
      .getByRole("button", { name: "Refresh permissions", exact: true })
      .click();
    await expect(permission(p).getByRole("status")).toContainText(
      "Permission history loaded",
    );
    await permission(p)
      .getByLabel("Mac for task permission", { exact: true })
      .selectOption(f.mac.binding.deviceId);
    await permission(p)
      .getByLabel("Allow this browser to send tasks to this Mac", {
        exact: true,
      })
      .check();
    await permission(p)
      .getByLabel("Allow this browser to read results from this Mac", {
        exact: true,
      })
      .check();
    await permission(p)
      .getByRole("button", { name: "Review task permission", exact: true })
      .click();
    await permission(p)
      .getByLabel("I reviewed this Mac and these exact permission choices.", {
        exact: true,
      })
      .check();
    await permission(p)
      .getByRole("button", { name: "Save browser permission", exact: true })
      .click();
    await expect(permission(p).getByRole("status")).toContainText(
      "Browser permission saved",
    );
    await refresh(p);
    return f;
  } catch (e) {
    f.mac.close();
    throw e;
  }
}
async function review(
  p: Page,
  f: Awaited<ReturnType<typeof ready>>,
  prompt = text,
  kind = "query",
) {
  await refresh(p);
  await panel(p)
    .getByLabel("Mac for this task", { exact: true })
    .selectOption(f.mac.binding.deviceId);
  await panel(p).getByLabel("Task type", { exact: true }).selectOption(kind);
  await panel(p)
    .getByLabel("What should your Mac work on?", { exact: true })
    .fill(prompt);
  await panel(p)
    .getByRole("button", { name: "Review task content", exact: true })
    .click();
  await expect(
    panel(p).getByRole("heading", {
      name: "Review the exact task",
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    panel(p).locator(".browser-task-exact").filter({ visible: true }),
  ).toContainText(prompt);
}
async function prepared(p: Page, f: Awaited<ReturnType<typeof ready>>) {
  await review(p, f);
  await confirm(p, "Confirm task preparation");
  await expect(panel(p).getByRole("status")).toContainText(
    "Task preparation saved",
  );
}
async function handoff(p: Page): Promise<PrivateEnvelope> {
  await panel(p)
    .getByRole("button", { name: "Review encrypted task handoff", exact: true })
    .click();
  await confirm(p, "Show encrypted task message");
  await expect(
    panel(p).getByRole("heading", {
      name: "Encrypted task ready for handoff",
      exact: true,
    }),
  ).toBeFocused();
  return JSON.parse(
    await panel(p)
      .getByLabel("Encrypted task message to share", { exact: true })
      .inputValue(),
  );
}
async function receive(
  p: Page,
  f: Awaited<ReturnType<typeof ready>>,
  kind: "receipt" | "result",
  envelope: PrivateEnvelope,
) {
  await refresh(p);
  await panel(p)
    .getByLabel("Mac for this task", { exact: true })
    .selectOption(f.mac.binding.deviceId);
  await panel(p)
    .getByLabel("Message from your Mac", { exact: true })
    .selectOption(kind);
  await panel(p)
    .getByLabel("Encrypted message", { exact: true })
    .fill(JSON.stringify(envelope));
  await panel(p)
    .getByRole("button", { name: "Review incoming task message", exact: true })
    .click();
  await confirm(p, "Confirm incoming task message");
  await expect(panel(p).getByRole("status")).toContainText("Task change saved");
}
async function exported(p: Page) {
  await panel(p)
    .getByRole("button", { name: "Review task history export", exact: true })
    .click();
  await expect(panel(p)).toContainText("original task text in readable form");
  const event = p.waitForEvent("download");
  await confirm(p, "Export reviewed task history");
  return JSON.parse(await readFile((await (await event).path())!, "utf8"));
}
async function stored(p: Page) {
  return p.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 6);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<{
        entries: any[];
        channels: any[];
        preparations: number;
      }>((resolve, reject) => {
        const tx = db.transaction(["entries", "channels", "task_preparations"]),
          data = {
            entries: [] as any[],
            channels: [] as any[],
            preparations: 0,
          };
        for (const name of ["entries", "channels"] as const) {
          const r = tx.objectStore(name).getAll();
          r.onsuccess = () => {
            data[name] = r.result;
          };
        }
        const r = tx.objectStore("task_preparations").count();
        r.onsuccess = () => {
          data.preparations = r.result;
        };
        tx.oncomplete = () => resolve(data);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}
async function preview(p: Page, engine: string, state: string) {
  await mkdir("test-results", { recursive: true });
  for (const [name, width, height] of [
    ["desktop", 1280, 1100],
    ["phone", 390, 844],
  ] as const) {
    await p.setViewportSize({ width, height });
    await expect
      .poll(() =>
        p.evaluate(() => ({
          overflow: Math.max(
            0,
            document.documentElement.scrollWidth - innerWidth,
          ),
          offenders: [...document.querySelectorAll("body *")]
            .filter((n) => n.getBoundingClientRect().right > innerWidth)
            .map((n) => n.tagName),
        })),
      )
      .toEqual({ overflow: 0, offenders: [] });
    await panel(p).screenshot({
      path: `test-results/browser-task-controls-${engine}-${name}-${state}.png`,
    });
  }
}

test("built task controls review exact input, require separate handoff and open the actual Mac result as text", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const before = await stored(page);
    expect(before.entries).toEqual([]);
    await review(page, f);
    expect((await stored(page)).entries).toEqual([]);
    await confirm(page, "Confirm task preparation");
    await expect(panel(page).getByRole("status")).toContainText(
      "nothing was sent automatically",
    );
    const saved = await stored(page);
    expect(saved.entries).toHaveLength(1);
    expect(saved.preparations).toBe(1);
    expect(JSON.stringify(saved)).not.toContain(text);
    const wire = await handoff(page),
      executed = await f.mac.executeTask(wire);
    expect(executed.task!.input.prompt).toBe(text);
    await receive(page, f, "receipt", executed.acceptance);
    await receive(page, f, "result", executed.result);
    await expect(panel(page)).not.toContainText(
      "Synthetic result from independently consented Mac task.",
    );
    await panel(page)
      .getByRole("button", { name: "Review opening this result", exact: true })
      .click();
    await confirm(page, "Open reviewed task result");
    await expect(panel(page)).toContainText(
      "Synthetic result from independently consented Mac task.",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(panel(page)).not.toContainText(
      "Synthetic result from independently consented Mac task.",
    );
    await refresh(page);
    const output = await exported(page);
    expect(output.entries[0].input.prompt).toBe(text);
    expect(output.restoreAuthority).toBe(false);
    expect(JSON.stringify(output)).not.toMatch(
      /privateKey|preparationKey|"key":/,
    );
  } finally {
    f.mac.close();
  }
});

for (const kind of ["summarize", "draft"])
  test(`built task controls preserve the reviewed ${kind} kind without allowing source or model selection`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      await review(page, f, text, kind);
      await confirm(page, "Confirm task preparation");
      await expect(panel(page).getByRole("status")).toContainText(
        "Task preparation saved",
      );
      const data = await exported(page);
      expect(data.entries[0].input).toEqual({
        version: 1,
        type: "task.submit",
        kind,
        prompt: text,
      });
      expect(JSON.stringify(data.entries[0].input)).not.toMatch(
        /modelProfileId|sources|tools|memory|conversationId/,
      );
    } finally {
      f.mac.close();
    }
  });

for (const loss of ["Escape", "blur", "account"] as const)
  test(`task content review clears on ${loss} without reserving or sending`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      await review(page, f);
      await panel(page).getByRole("checkbox").check();
      if (loss === "Escape") await page.keyboard.press("Escape");
      else if (loss === "blur")
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      else await page.evaluate(() => window.remoteAuthWalletTest.change());
      await expect(
        panel(page).getByRole("heading", {
          name: "Review the exact task",
          exact: true,
        }),
      ).toBeHidden();
      expect((await stored(page)).entries).toEqual([]);
      if (loss === "account") await expect(panel(page)).toHaveCount(0);
      else {
        await refresh(page);
        await expect(
          panel(page).getByLabel("What should your Mac work on?", {
            exact: true,
          }),
        ).toHaveValue("");
      }
    } finally {
      f.mac.close();
    }
  });

test("lost final task confirmation is reconciled from saved history after reload without another task", async ({
  page,
  identityServer,
}) => {
  const f = await ready(page);
  try {
    await review(page, f);
    identityServer.reject("/browser/registration/identity", 1);
    await confirm(page, "Confirm task preparation");
    await expect(panel(page).getByRole("alert")).toContainText(
      "failed response may follow a saved change",
    );
    const saved = await stored(page);
    expect(saved.entries).toHaveLength(1);
    await page.reload();
    await expect(page.locator("#account")).toContainText("Verified wallet:");
    await openRecovery(page);
    await refreshRegistration(page);
    await refresh(page);
    const wire = await handoff(page);
    expect(wire).toEqual(saved.entries[0].envelope);
    const after = await stored(page);
    expect(after.entries).toHaveLength(1);
    expect(after.channels).toEqual(saved.channels);
  } finally {
    f.mac.close();
  }
});

test("interrupted publication exposes an explicit same-operation resume in the built task history", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    await review(page, f);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (this.name === "entries" && args[0]?.state === "pending") {
          IDBObjectStore.prototype.put = put;
          throw new DOMException(
            "synthetic publication quota",
            "QuotaExceededError",
          );
        }
        return put.apply(this, args);
      };
    });
    await confirm(page, "Confirm task preparation");
    await expect(panel(page).getByRole("alert")).toContainText(
      "local storage could not complete",
    );
    const saved = await stored(page);
    expect(saved.entries[0].state).toBe("reserved");
    await refresh(page);
    await panel(page)
      .getByRole("button", { name: "Review resuming this task", exact: true })
      .click();
    await confirm(page, "Confirm task resume");
    await expect(panel(page).getByRole("status")).toContainText(
      "Task preparation saved",
    );
    const wire = await handoff(page);
    expect(wire.header).toEqual(saved.entries[0].header);
    expect((await stored(page)).channels).toEqual(saved.channels);
    expect((await f.mac.executeTask(wire)).task!.input.prompt).toBe(text);
  } finally {
    f.mac.close();
  }
});

test("owner task export, stop and deletion remain usable offline after browser permission revocation", async ({
  page,
  identityServer,
}) => {
  const f = await ready(page);
  try {
    await prepared(page, f);
    const saved = await stored(page);
    await permission(page)
      .getByRole("button", { name: "Refresh permissions", exact: true })
      .click();
    await expect(permission(page).getByRole("status")).toContainText(
      "Permission history loaded",
    );
    await permission(page)
      .getByRole("button", { name: "Review revoking permission", exact: true })
      .click();
    await permission(page).getByRole("checkbox").check();
    await permission(page)
      .getByRole("button", { name: "Revoke browser permission", exact: true })
      .click();
    await expect(permission(page).getByRole("status")).toContainText(
      "revoked on this browser only",
    );
    identityServer.offline(true);
    await refresh(page);
    const data = await exported(page);
    expect(data.entries[0].input.prompt).toBe(text);
    await panel(page)
      .getByRole("button", {
        name: "Review stopping task retries",
        exact: true,
      })
      .click();
    await confirm(page, "Stop task retries");
    await expect(panel(page)).toContainText("Further retries stopped");
    await panel(page)
      .getByRole("button", {
        name: "Review task history deletion",
        exact: true,
      })
      .click();
    await confirm(page, "Delete reviewed task history");
    await expect(panel(page).getByRole("status")).toContainText(
      "Task content deleted",
    );
    const after = await stored(page);
    expect(after.entries).toEqual([]);
    expect(after.preparations).toBe(0);
    expect(after.channels).toEqual(saved.channels);
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});

test("task controls show readable exact content, saved handoff and results at desktop and phone widths", async ({
  page,
}, info) => {
  const f = await ready(page);
  try {
    await preview(page, info.project.name, "compose");
    await review(page, f, text + "\n" + "x".repeat(350));
    await preview(page, info.project.name, "review");
    await confirm(page, "Confirm task preparation");
    await expect(panel(page).getByRole("status")).toContainText(
      "Task preparation saved",
    );
    await preview(page, info.project.name, "history");
    const wire = await handoff(page);
    await preview(page, info.project.name, "handoff");
    const executed = await f.mac.executeTask(wire);
    await receive(page, f, "result", executed.result);
    await panel(page)
      .getByRole("button", { name: "Review opening this result", exact: true })
      .click();
    await confirm(page, "Open reviewed task result");
    await expect(panel(page)).toContainText(
      "Synthetic result from independently consented Mac task.",
    );
    await preview(page, info.project.name, "result");
  } finally {
    f.mac.close();
  }
});

test("oversized UTF-8 task input reaches no reservation or sender counter", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const before = await stored(page);
    await panel(page)
      .getByLabel("Mac for this task", { exact: true })
      .selectOption(f.mac.binding.deviceId);
    await panel(page)
      .getByLabel("What should your Mac work on?", { exact: true })
      .fill("界".repeat(32000));
    await panel(page)
      .getByRole("button", { name: "Review task content", exact: true })
      .click();
    await expect(panel(page).getByRole("alert")).toContainText(
      "exceeded a limit",
    );
    await expect(
      panel(page).getByRole("heading", {
        name: "Review the exact task",
        exact: true,
      }),
    ).toBeHidden();
    expect(await stored(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});

test("a permission change in another tab invalidates the original exact-content review", async ({
  page,
  context,
}) => {
  const f = await ready(page),
    other = await context.newPage();
  try {
    await other.goto("https://ai.bittrees.org/?browser-peers");
    await other.waitForFunction(() => !!window.browserPeersTest);
    await other.evaluate(() => window.browserPeersTest.resume());
    await page.bringToFront();
    await review(page, f);
    const before = await stored(page),
      permission = await other.evaluate(() =>
        window.browserPeersTest.consentStatus(),
      );
    await other.evaluate((raw) => window.browserPeersTest.consentRevoke(raw), {
      peerId: f.mac.binding.deviceId,
      expectedRevision: permission.revision,
      confirmed: true,
    });
    await confirm(page, "Confirm task preparation");
    await expect(panel(page).getByRole("alert")).toContainText(
      "changed during review",
    );
    expect(await stored(page)).toEqual(before);
    await expect(
      panel(page).getByRole("heading", {
        name: "Review the exact task",
        exact: true,
      }),
    ).toBeHidden();
  } finally {
    await other.close();
    f.mac.close();
  }
});

test("task review expires without extending the original confirmation window", async ({
  page,
}) => {
  await page.clock.install();
  const f = await ready(page);
  try {
    await review(page, f);
    const before = await stored(page);
    await panel(page).getByRole("checkbox").check();
    await page.clock.fastForward(120001);
    await expect(
      panel(page).getByRole("heading", {
        name: "Review the exact task",
        exact: true,
      }),
    ).toBeHidden();
    await expect(panel(page).getByRole("status")).toContainText("expired");
    expect(await stored(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});

test("another device control closes an old task review before confirmation", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    await review(page, f);
    const before = await stored(page);
    await keyControls(page)
      .getByRole("button", { name: "Refresh keys", exact: true })
      .click();
    await expect(
      panel(page).getByRole("heading", {
        name: "Review the exact task",
        exact: true,
      }),
    ).toBeHidden();
    expect(await stored(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});

test("task review displays markup-looking prompt content only as text", async ({
  page,
}) => {
  const f = await ready(page),
    prompt =
      '<img src="https://invalid.example/task" onerror="window.taskInjected=true">\n<script>window.taskInjected=true</script>';
  try {
    await review(page, f, prompt);
    await expect(panel(page).locator("img, script")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).taskInjected),
    ).toBeUndefined();
    await confirm(page, "Confirm task preparation");
    await expect(panel(page).getByRole("status")).toContainText(
      "Task preparation saved",
    );
    const data = await exported(page);
    expect(data.entries[0].input.prompt).toBe(prompt);
  } finally {
    f.mac.close();
  }
});
