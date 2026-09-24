import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { macConversationDeliveryFixture } from "../helpers/mac-conversation-delivery-ui.js";
async function fixture(page: Page, questions = false) {
  const g = await macConversationDeliveryFixture(questions);
  try {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let losePreparation = false;
    await page.route("**/v1/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const result = await fetch(
        `http://127.0.0.1:${g.port}${url.pathname}${url.search}`,
        {
          method: request.method(),
          headers: {
            Authorization: "Bearer " + g.token,
            "Content-Type": "application/json",
          },
          ...(request.postData() ? { body: request.postData()! } : {}),
        },
      );
      const body = await result.text();
      if (
        losePreparation &&
        url.pathname === "/v1/private-conversation-content/prepare"
      ) {
        losePreparation = false;
        await route.abort();
        return;
      }
      await route.fulfill({
        status: result.status,
        contentType: "application/json",
        body,
      });
    });
    const question = questions ? await g.question() : undefined;
    await page.goto("/?inbox-task-review");
    await page
      .getByRole("button", {
        name: /PRIVATE_NEVER_IN_OFFER|Task-linked message|Where are you travelling/,
      })
      .first()
      .click();
    await page
      .getByRole("button", {
        name: "Refresh conversation choices",
        exact: true,
      })
      .click();
    const panel = page.getByRole("region", {
      name: "Conversation message delivery",
      exact: true,
    });
    const refresh = () =>
      panel
        .getByRole("button", { name: "Refresh delivery history", exact: true })
        .click();
    await refresh();
    const review = async (id = g.message.id) => {
      await panel
        .getByRole("combobox", { name: "Message destination", exact: true })
        .selectOption(g.permissionId);
      await panel
        .getByRole("combobox", { name: "Saved local message", exact: true })
        .selectOption(id);
      await panel
        .getByRole("button", { name: "Review encrypted copy", exact: true })
        .click();
      await expect(
        panel.getByRole("group", {
          name: "Conversation delivery review",
          exact: true,
        }),
      ).toBeVisible();
    };
    const confirm = async (name: string) => {
      await panel.getByRole("checkbox").check();
      await panel.getByRole("button", { name, exact: true }).click();
    };
    const send = async () => {
      await panel
        .getByRole("button", {
          name: "Refresh message connections",
          exact: true,
        })
        .click();
      await panel
        .getByRole("combobox", { name: "Message connection", exact: true })
        .selectOption(g.input().connection.id);
      await panel
        .getByRole("button", {
          name: "Review encrypted message upload",
          exact: true,
        })
        .click();
      await expect(panel.getByRole("checkbox")).not.toBeChecked();
    };
    return {
      ...g,
      panel,
      errors,
      refresh,
      review,
      confirm,
      send,
      question,
      losePreparation: () => {
        losePreparation = true;
      },
    };
  } catch (e) {
    await g.close();
    throw e;
  }
}
async function shots(page: Page, browser: string, name: string) {
  await mkdir("test-results/mac-conversation-delivery-ui", { recursive: true });
  for (const [size, width, height] of [
    ["desktop", 1280, 900],
    ["phone", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      overflowing: Array.from(document.querySelectorAll("body *"))
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
        .map((e) => ({
          tag: e.tagName,
          className: e.className,
          width: e.getBoundingClientRect().width,
          text: (e.textContent ?? "").slice(0, 100),
        })),
    }));
    await page.screenshot({
      path: `test-results/mac-conversation-delivery-ui/${browser}-${name}-${size}.png`,
      fullPage: true,
    });
    expect(layout.width <= layout.viewport, JSON.stringify(layout)).toBe(true);
  }
}
test("Mac conversation controls prepare and separately upload the original encrypted message then stop offline", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    await shots(page, info.project.name, "empty");
    await g.review();
    const confirm = g.panel.getByRole("button", {
      name: "Prepare encrypted copy",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await expect(g.panel.getByRole("checkbox")).not.toBeChecked();
    await expect(g.panel).toContainText("PRIVATE_NEVER_IN_OFFER");
    expect(g.outgoing.size).toBe(0);
    await shots(page, info.project.name, "prepare-review");
    await g.confirm("Prepare encrypted copy");
    await expect(g.panel.getByRole("status")).toContainText(
      "prepared on this Mac",
    );
    expect(g.outgoing.size).toBe(0);
    const original = g.e.store.exportPrivateConversationContent(g.e.owner)[0]!
      .value.envelope;
    await g.send();
    await expect(
      g.panel.getByRole("button", {
        name: "Upload encrypted copy",
        exact: true,
      }),
    ).toBeDisabled();
    await shots(page, info.project.name, "upload-review");
    await g.confirm("Upload encrypted copy");
    await expect(g.panel.getByRole("status")).toContainText(
      "Server storage recorded",
    );
    await expect(g.panel).toContainText(
      "Recipient storage has not been confirmed",
    );
    expect([...g.outgoing.values()][0]!.envelope).toEqual(original);
    await shots(page, info.project.name, "stored");
    g.e.deny();
    await g.panel
      .getByRole("button", { name: "Review stopping uploads", exact: true })
      .click();
    await expect(g.panel.getByRole("checkbox")).not.toBeChecked();
    await shots(page, info.project.name, "stop-review");
    await g.confirm("Stop further uploads");
    await expect(g.panel.getByRole("status")).toContainText(
      "Further uploads stopped",
    );
    expect(g.outgoing.size).toBe(1);
    await shots(page, info.project.name, "stopped");
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("Mac conversation controls inspect uncertain preparation and reuse original ciphertext after a lost upload reply", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    g.losePreparation();
    await g.review();
    await g.confirm("Prepare encrypted copy");
    await expect(g.panel.getByRole("alert")).toContainText(
      "No automatic retry",
    );
    const original = g.e.controls.conversationContentStatus().items[0]!;
    expect(original.state).toBe("preparing");
    await g.refresh();
    await expect(g.panel).toContainText("Preparation interrupted");
    await shots(page, info.project.name, "preparation-uncertain");
    await g.panel
      .getByRole("button", {
        name: "Review finishing encrypted copy",
        exact: true,
      })
      .click();
    await g.confirm("Prepare encrypted copy");
    await expect(g.panel.getByRole("status")).toContainText(
      "prepared on this Mac",
    );
    g.control.loseSubmit = true;
    await g.send();
    await g.confirm("Upload encrypted copy");
    await expect(g.panel.getByRole("alert")).toContainText(
      "No automatic retry",
    );
    expect(g.outgoing.size).toBe(1);
    const wire = [...g.outgoing.values()][0]!.envelope;
    await g.refresh();
    await expect(g.panel).toContainText("Upload attempt 1 is unconfirmed");
    await shots(page, info.project.name, "upload-uncertain");
    g.control.loseSubmit = false;
    await g.send();
    await g.confirm("Upload encrypted copy");
    await expect(g.panel.getByRole("status")).toContainText(
      "Server storage recorded",
    );
    expect([...g.outgoing.values()][0]!.envelope).toEqual(wire);
    expect(g.e.controls.conversationContentStatus().items[0]!.id).toBe(
      original.id,
    );
    expect(g.outgoing.size).toBe(1);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
test("Mac conversation review clears exact text and unchecked confirmation on focus loss and Escape", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    await g.review();
    await g.panel.getByRole("checkbox").check();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(
      g.panel.getByRole("group", { name: "Conversation delivery review" }),
    ).toHaveCount(0);
    await expect(g.panel).toHaveCount(0);
    expect(g.e.controls.conversationContentStatus().items).toEqual([]);
    await shots(page, info.project.name, "cancelled");
    // Parent permission review also clears; explicitly refresh it to reopen delivery.
    await page
      .getByRole("button", {
        name: "Refresh conversation choices",
        exact: true,
      })
      .click();
    await g.refresh();
    await g.review();
    await expect(g.panel.getByRole("checkbox")).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(
      g.panel.getByRole("group", { name: "Conversation delivery review" }),
    ).toHaveCount(0);
    expect(g.e.controls.conversationContentStatus().items).toEqual([]);
  } finally {
    await g.close();
  }
});
test("Mac conversation controls prepare an exact real worker question without answering or running it", async ({
  page,
}, info) => {
  const g = await fixture(page, true);
  try {
    await g.review(g.question!.wait.questionId);
    await expect(g.panel).toContainText("Exact AI question");
    await expect(g.panel).toContainText("Where are you travelling?");
    await shots(page, info.project.name, "question-review");
    await g.confirm("Prepare encrypted copy");
    await expect(g.panel.getByRole("status")).toContainText(
      "prepared on this Mac",
    );
    expect(g.e.controls.conversationContentStatus().items[0]!.kind).toBe(
      "conversation.question",
    );
    expect(g.e.store.get(g.e.owner, g.question!.task.id).status).toBe(
      "awaiting_input",
    );
    expect(
      g.e.store.inputWaitHistory(g.e.owner, g.question!.task.id)[0]!.replyId,
    ).toBeNull();
    expect(g.outgoing.size).toBe(0);
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});

test("Mac conversation history reviews an incoming storage receipt without sending another message", async ({
  page,
}, info) => {
  const g = await fixture(page);
  try {
    const receipt = await g.incomingReceipt(),
      before = g.e.store.messages(g.e.owner, g.inbox.id, g.conversationId);
    await g.refresh();
    await expect(g.panel).toContainText(
      "This sends only a receipt for content already stored on this Mac",
    );
    await g.panel
      .getByRole("button", { name: "Refresh message connections", exact: true })
      .click();
    await g.panel
      .getByRole("combobox", { name: "Message connection", exact: true })
      .selectOption(g.input().connection.id);
    await g.panel
      .getByRole("button", {
        name: "Review storage receipt upload",
        exact: true,
      })
      .click();
    await expect(g.panel.getByRole("checkbox")).not.toBeChecked();
    await expect(g.panel).toContainText(
      "Upload the original encrypted storage receipt",
    );
    await shots(page, info.project.name, "receipt-review");
    await g.confirm("Upload storage receipt");
    await expect(g.panel.getByRole("status")).toContainText(
      "Server storage recorded",
    );
    expect([...g.outgoing.values()][0]!.envelope).toEqual(receipt.envelope);
    expect(g.e.store.messages(g.e.owner, g.inbox.id, g.conversationId)).toEqual(
      before,
    );
    await shots(page, info.project.name, "receipt-stored");
    expect(g.errors).toEqual([]);
  } finally {
    await g.close();
  }
});
