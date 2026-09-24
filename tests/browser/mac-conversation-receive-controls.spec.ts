import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { macConversationDeliveryFixture } from "../helpers/mac-conversation-delivery-ui.js";
const region = (page: Page) =>
  page.getByRole("region", {
    name: "Conversation message delivery",
    exact: true,
  });
const button = (page: Page, name: string) =>
  region(page).getByRole("button", { name, exact: true });
async function fixture(page: Page, questions = false) {
  const g = await macConversationDeliveryFixture(questions);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      r = await fetch(
        `http://127.0.0.1:${g.port}${url.pathname}${url.search}`,
        {
          method: req.method(),
          headers: {
            Authorization: "Bearer " + g.token,
            "Content-Type": "application/json",
          },
          ...(req.postData() ? { body: req.postData()! } : {}),
        },
      );
    await route.fulfill({
      status: r.status,
      contentType: "application/json",
      body: await r.text(),
    });
  });
  const open = async () => {
    await page.goto("/?inbox-task-review");
    await page
      .getByRole("button", {
        name: /PRIVATE_NEVER_IN_OFFER|SYNTHETIC_RELAY_CONVERSATION|Task-linked message|Where are you travelling/,
      })
      .first()
      .click();
    await page
      .getByRole("button", {
        name: "Refresh conversation choices",
        exact: true,
      })
      .click();
    await button(page, "Refresh delivery history").click();
    await expect(
      region(page).getByRole("heading", {
        name: "Saved delivery history",
        exact: true,
      }),
    ).toBeVisible();
  };
  try {
    await open();
  } catch (e) {
    await g.close();
    throw e;
  }
  const inspect = async () => {
    await button(page, "Refresh delivery history").click();
    await button(page, "Refresh message connections").click();
    await region(page)
      .getByRole("combobox", { name: "Message connection", exact: true })
      .selectOption(g.input().connection.id);
    await button(page, "Inspect incoming conversation").click();
    await expect(region(page).getByRole("status")).toContainText(
      "Incoming item inspected",
    );
    await region(page)
      .getByRole("combobox", { name: "Incoming browser access", exact: true })
      .selectOption(g.permissionId);
  };
  const review = async (copy?: string) => {
    if (copy) {
      await region(page)
        .getByRole("combobox", {
          name: "Sent copy for browser receipt",
          exact: true,
        })
        .selectOption(copy);
      await button(page, "Review browser storage receipt").click();
    } else await button(page, "Review receiving conversation item").click();
    await expect(
      region(page).getByRole("group", {
        name: "Conversation delivery review",
        exact: true,
      }),
    ).toBeVisible();
    await expect(region(page).getByRole("checkbox")).not.toBeChecked();
  };
  const confirm = async (name = "Receive reviewed item") => {
    await expect(button(page, name)).toBeDisabled();
    await region(page).getByRole("checkbox").check();
    await button(page, name).click();
  };
  return { ...g, open, inspect, review, confirm, errors };
}
async function shots(page: Page, info: TestInfo, state: string) {
  await mkdir("test-results/mac-conversation-receive-ui", { recursive: true });
  await expect(button(page, "Refresh delivery history")).toBeEnabled();
  for (const [size, width, height] of [
    ["desktop", 1280, 900],
    ["phone", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await region(page).screenshot({
      path: `test-results/mac-conversation-receive-ui/${info.project.name}-${state}-${size}.png`,
    });
  }
}
test("Mac incoming controls review one encrypted item and separately prepare and upload only its storage receipt", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    const wire = await g.envelope(g.incomingMessage());
    await g.queueEnvelope(wire);
    await g.inspect();
    await expect(region(page)).not.toContainText(
      "SYNTHETIC_RELAY_CONVERSATION",
    );
    expect(g.messages()).toHaveLength(1);
    await shots(page, info, "queue");
    await g.review();
    await expect(region(page)).toContainText(g.permission.choices.peerId);
    await shots(page, info, "receive-review");
    expect(g.messages()).toHaveLength(1);
    await g.confirm();
    await expect(region(page).getByRole("status")).toContainText(
      "saved on this Mac",
    );
    expect(g.messages()).toHaveLength(2);
    expect(g.outgoing.size).toBe(0);
    await shots(page, info, "received-history");
    await button(page, "Review preparing storage receipt").click();
    await expect(
      region(page).getByRole("heading", {
        name: "Review preparing this storage receipt",
        exact: true,
      }),
    ).toBeVisible();
    await shots(page, info, "prepare-receipt-review");
    await g.confirm("Prepare storage receipt");
    await expect(region(page).getByRole("status")).toContainText(
      "Storage receipt prepared",
    );
    expect(g.outgoing.size).toBe(0);
    await button(page, "Review storage receipt upload").click();
    await expect(
      region(page).getByRole("group", {
        name: "Conversation delivery review",
        exact: true,
      }),
    ).toBeVisible();
    await g.confirm("Upload storage receipt");
    await expect(region(page).getByRole("status")).toContainText(
      "Server storage recorded",
    );
    expect([...g.outgoing.values()][0]!.envelope).not.toEqual(wire);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("Mac incoming controls recover acknowledgement uncertainty after reload without duplicate Inbox messages", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    await g.queueEnvelope(await g.envelope(g.incomingMessage()));
    await g.inspect();
    await g.review();
    g.control.loseAck = true;
    await g.confirm();
    await expect(region(page).getByRole("alert")).toContainText(
      "No automatic retry",
    );
    expect(g.messages()).toHaveLength(2);
    await shots(page, info, "uncertain");
    g.control.loseAck = false;
    await g.open();
    await g.inspect();
    await g.review();
    await g.confirm();
    await expect(region(page).getByRole("status")).toContainText(
      "saved on this Mac",
    );
    expect(g.messages()).toHaveLength(2);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("Mac incoming controls keep missing-parent items queued and expose next-item navigation", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    const parent = g.incomingMessage(),
      wire = await g.envelope(g.incomingMessage(parent.id));
    await g.queueEnvelope(wire);
    await g.inspect();
    await g.review();
    await g.confirm();
    await expect(region(page).getByRole("alert")).toContainText(
      "Receive the earlier message first",
    );
    expect(g.messages()).toHaveLength(1);
    await shots(page, info, "parent-needed");
    await g.inspect();
    await button(page, "Inspect next conversation item").click();
    await expect(region(page).getByRole("status")).toContainText(
      "No incoming item here",
    );
    await shots(page, info, "next-empty");
    await g.queueEnvelope(await g.envelope(parent));
    await g.inspect();
    await g.review();
    await g.confirm();
    await expect(region(page).getByRole("status")).toContainText(
      "saved on this Mac",
    );
    await g.queueEnvelope(wire);
    await g.inspect();
    await g.review();
    await g.confirm();
    await expect(region(page).getByRole("status")).toContainText(
      "saved on this Mac",
    );
    expect(g.messages()).toHaveLength(3);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("Mac incoming browser receipt review binds one outgoing copy and shows authenticated storage separately", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    const c = g.controller();
    await g.prepare(c);
    const copy = c.items()[0]!;
    await g.queueEnvelope(
      await g.envelope({
        version: 1,
        type: "conversation.received",
        scope: g.scope,
        operationId: copy.id,
        acceptedId: copy.id,
        acceptedType: copy.kind,
        acceptedAt: g.f.clock(),
      }),
    );
    await g.inspect();
    await g.review(copy.id);
    await expect(region(page)).toContainText(g.message.input.content);
    await shots(page, info, "browser-receipt-review");
    await g.confirm("Check reviewed browser receipt");
    await expect(region(page).getByRole("status")).toContainText(
      "Browser storage receipt authenticated",
    );
    expect(g.messages()).toHaveLength(1);
    await shots(page, info, "browser-storage-confirmed");
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("Mac incoming review clears on focus loss and ignores a late authenticated response", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    await g.queueEnvelope(await g.envelope(g.incomingMessage()));
    await g.inspect();
    await g.review();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(button(page, "Receive reviewed item")).toBeHidden();
    expect(g.messages()).toHaveLength(1);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await g.inspect();
    await g.review();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    g.control.beforePoll = async () => {
      entered();
      await held;
    };
    await g.confirm();
    await started;
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    release();
    await expect(button(page, "Refresh delivery history")).toBeEnabled();
    await expect(region(page)).not.toContainText("saved on this Mac");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await button(page, "Refresh delivery history").click();
    await expect(
      button(page, "Review preparing storage receipt"),
    ).toBeVisible();
    expect(g.messages()).toHaveLength(2);
    await shots(page, info, "cancelled-history");
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("Mac incoming controls authenticate an exact worker answer and resume the task once", async ({
  page,
}, info) => {
  const g = await fixture(page, true);
  try {
    const q = await g.question(),
      c = g.controller();
    await g.prepare(c, q.wait.questionId);
    const copy = c.items()[0]!,
      content = g.e.store
        .exportPrivateConversationContent(g.e.owner)
        .find((e) => e.value.content.id === copy.id)!.value.content;
    if (content.type !== "conversation.question")
      throw Error("Expected question");
    await g.queueEnvelope(
      await g.envelope({
        version: 1,
        type: "conversation.answer",
        scope: g.scope,
        id: randomUUID(),
        taskId: q.task.id,
        questionId: copy.id,
        expectedRevision: content.taskRevision,
        content: "Lisbon",
        confirmed: true,
      }),
    );
    await g.inspect();
    await g.review();
    await expect(region(page)).toContainText(
      "valid answer can resume its exact waiting task",
    );
    await shots(page, info, "answer-review");
    await g.confirm();
    await expect(region(page).getByRole("status")).toContainText(
      "saved on this Mac",
    );
    expect(g.e.store.get(g.e.owner, q.task.id).status).toBe("queued");
    await q.run();
    expect(g.e.store.get(g.e.owner, q.task.id).status).toBe("completed");
    await q.run();
    expect(q.calls()).toBe(3);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
