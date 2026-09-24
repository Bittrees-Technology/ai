import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import {
  setup,
  completeBrowserCheck,
  refresh as refreshChecks,
  incoming,
  confirm as confirmCheck,
  output,
} from "./support/browser-mac-ui.js";
import {
  openRecovery,
  refreshRegistration,
} from "./support/browser-recovery-ui.js";
import { mkdir, readFile } from "node:fs/promises";
const panel = (p: Page) =>
  p.getByRole("region", { name: "Saved conversations", exact: true });
const permissions = (p: Page) =>
  p.getByRole("region", {
    name: "Browser conversation permissions",
    exact: true,
  });
const ackName = "I reviewed this conversation and this exact action.";
async function ready(page: Page) {
  const f = await setup(page);
  try {
    await completeBrowserCheck(page, f);
    const challenge = await f.macBegin();
    await refreshChecks(page);
    await incoming(
      page,
      await f.mac.checks.delivery({ id: challenge.id, confirmed: true }),
      "answer",
    );
    await confirmCheck(page, "Answer Mac check");
    await f.mac.checks.complete({
      envelope: await output(page),
      confirmed: true,
    });
    const offer = await f.mac.conversationOffer(undefined, { questions: true });
    const region = permissions(page);
    await region
      .getByRole("button", {
        name: "Refresh conversation permissions",
        exact: true,
      })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Permission history loaded",
    );
    await region
      .getByLabel("Mac for conversation access", { exact: true })
      .selectOption(f.mac.binding.deviceId);
    await region
      .getByLabel("Encrypted conversation offer from your Mac", { exact: true })
      .fill(JSON.stringify(offer.envelope));
    await region
      .getByRole("button", { name: "Open selected Mac offer", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Mac offer authenticated",
    );
    for (const name of [
      "Allow messages from this browser to the Mac",
      "Allow messages from the Mac to this browser",
      "Allow task questions from the Mac to this browser",
      "Allow reviewed answers from this browser to the Mac",
    ])
      await region.getByLabel(name, { exact: true }).check();
    await region
      .getByLabel("Conversation access duration", { exact: true })
      .selectOption("15");
    await region
      .getByRole("button", { name: "Review conversation access", exact: true })
      .click();
    await region
      .getByLabel(
        "I reviewed this conversation, Mac and these exact choices.",
        { exact: true },
      )
      .check();
    await region
      .getByRole("button", { name: "Save conversation access", exact: true })
      .click();
    await expect(region.getByRole("status")).toContainText(
      "Browser conversation access saved",
    );
    await refresh(page);
    return { ...f, offer };
  } catch (e) {
    f.mac.close();
    throw e;
  }
}
async function refresh(page: Page) {
  await panel(page)
    .getByRole("button", { name: "Refresh saved conversations", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Saved conversation list loaded",
  );
}
async function confirm(page: Page, name: string) {
  const button = panel(page).getByRole("button", { name, exact: true });
  await expect(button).toBeDisabled();
  await expect(
    panel(page).getByLabel(ackName, { exact: true }),
  ).not.toBeChecked();
  await panel(page).getByLabel(ackName, { exact: true }).check();
  await button.click();
}
async function importFile(page: Page, envelope: unknown) {
  await panel(page)
    .getByLabel("Choose an encrypted message file", { exact: true })
    .setInputFiles({
      name: "message-from-mac.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(envelope)),
    });
  await panel(page)
    .getByRole("button", { name: "Review message file", exact: true })
    .click();
  await expect(
    panel(page).getByRole("heading", {
      name: "Open and save this message file",
      exact: true,
    }),
  ).toBeFocused();
  await confirm(page, "Open reviewed message file");
  await expect(panel(page).getByRole("status")).toContainText(
    "Message authenticated and saved",
  );
  await refresh(page);
}
async function openFirst(page: Page, name = "Open message from mac 1") {
  await panel(page).getByRole("button", { name, exact: true }).click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Selected message opened",
  );
}
async function download(page: Page, receipt = false) {
  await panel(page)
    .getByRole("button", {
      name: receipt
        ? "Review receipt download"
        : "Review encrypted message download",
      exact: true,
    })
    .click();
  const downloaded = page.waitForEvent("download");
  await confirm(
    page,
    receipt ? "Download reviewed receipt" : "Download reviewed message",
  );
  return JSON.parse(await readFile((await (await downloaded).path())!, "utf8"));
}
async function preview(page: Page, engine: string, state: string) {
  await mkdir("test-results/browser-conversation-content-ui", {
    recursive: true,
  });
  for (const [label, width, height] of [
    ["desktop", 1280, 1000],
    ["phone", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const ack = panel(page).getByLabel(ackName, { exact: true });
    if (await ack.isVisible()) {
      const input = await ack.boundingBox(),
        text = await panel(page)
          .locator(".browser-keys-check span")
          .boundingBox();
      expect(input!.x + input!.width).toBeLessThanOrEqual(text!.x);
    }
    await panel(page).screenshot({
      path: `test-results/browser-conversation-content-ui/${engine}-${label}-${state}.png`,
    });
  }
}
test("built conversation controls open actual Mac files, preserve literal text and download an ordinary reply", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await ready(page);
  try {
    await preview(page, info.project.name, "empty");
    const text =
      "SYNTHETIC: Your appointment is at 14:00. <img src=x onerror=alert(1)>";
    await importFile(page, await f.offer.message(text));
    await expect(panel(page)).not.toContainText(text);
    await openFirst(page);
    await expect(
      panel(page).locator(".conversation-content-text").first(),
    ).toHaveText(text);
    expect(await panel(page).locator("img").count()).toBe(0);
    await preview(page, info.project.name, "reading");
    await panel(page)
      .getByRole("button", { name: "Reply to this message", exact: true })
      .click();
    await panel(page)
      .getByLabel("Message text", { exact: true })
      .fill("Confirmed, thank you.");
    await panel(page)
      .getByRole("button", { name: "Review saving message", exact: true })
      .click();
    await expect(
      panel(page).getByRole("heading", {
        name: "Save this message for your Mac",
        exact: true,
      }),
    ).toBeFocused();
    await expect(panel(page)).toContainText("ordinary reply");
    await preview(page, info.project.name, "reply-review");
    await confirm(page, "Save reviewed message");
    await expect(panel(page).getByRole("status")).toContainText(
      "Message saved locally",
    );
    await refresh(page);
    await openFirst(page, "Open message to mac 2");
    const envelope = await download(page);
    const accepted = await f.offer.receive(envelope);
    expect(accepted.duplicate).toBe(false);
    expect(accepted.entry.value.content.content).toBe("Confirmed, thank you.");
    expect((await f.offer.receive(envelope)).duplicate).toBe(true);
    await page.reload();
    await expect(page.locator("#account")).toContainText("Verified wallet:");
    await openRecovery(page);
    await refreshRegistration(page);
    await refresh(page);
    await openFirst(page, "Open message to mac 2");
    expect(await download(page)).toEqual(envelope);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(() => typeof (window as any).browserPeersTest),
    ).toBe("undefined");
  } finally {
    f.mac.close();
  }
});

test("built question controls distinguish ordinary replies from the exact answer that resumes a real Mac worker", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const f = await ready(page);
  try {
    const question = await f.offer.question();
    expect(question.task().status).toBe("awaiting_input");
    await importFile(page, question.envelope);
    await openFirst(page, "Open question from mac 1");
    await expect(panel(page)).toContainText("Where are you travelling?");
    await preview(page, info.project.name, "question");
    await panel(page)
      .getByRole("button", { name: "Reply to this message", exact: true })
      .click();
    await panel(page)
      .getByLabel("Message text", { exact: true })
      .fill("I will answer shortly.");
    await panel(page)
      .getByRole("button", { name: "Review saving message", exact: true })
      .click();
    await confirm(page, "Save reviewed message");
    await refresh(page);
    await openFirst(page, "Open message to mac 2");
    await f.offer.receive(await download(page));
    expect(question.task().status).toBe("awaiting_input");
    await refresh(page);
    await openFirst(page, "Open question from mac 1");
    await panel(page)
      .getByRole("button", { name: "Answer this question", exact: true })
      .click();
    await panel(page)
      .getByLabel("Message text", { exact: true })
      .fill("Lisbon");
    await panel(page)
      .getByRole("button", { name: "Review saving answer", exact: true })
      .click();
    await expect(panel(page)).toContainText("exact task and revision");
    await expect(
      panel(page).locator(".conversation-content-review"),
    ).toContainText(
      "Question:\nWhere are you travelling?\n\nYour answer:\nLisbon",
    );
    await preview(page, info.project.name, "answer-review");
    await confirm(page, "Save reviewed answer");
    await refresh(page);
    await openFirst(page, "Open answer to mac 3");
    const envelope = await download(page);
    expect((await f.offer.receive(envelope)).duplicate).toBe(false);
    expect(question.task().status).toBe("queued");
    await question.run();
    expect(question.task().status).toBe("completed");
    const calls = question.calls();
    expect((await f.offer.receive(envelope)).duplicate).toBe(true);
    await question.run();
    expect(question.calls()).toBe(calls);
  } finally {
    f.mac.close();
  }
});

test("private drafts and reviews clear on escape and focus loss without saving or sending", async ({
  page,
  identityServer,
}, info) => {
  test.setTimeout(60000);
  const f = await ready(page);
  try {
    identityServer.events.length = 0;
    const secret = "SYNTHETIC_UNSAVED_PRIVATE_DRAFT";
    await panel(page).getByLabel("Message text", { exact: true }).fill(secret);
    expect(
      await page.evaluate(
        (secret) =>
          Object.values(localStorage).some((value) =>
            String(value).includes(secret),
          ),
        secret,
      ),
    ).toBe(false);
    await panel(page)
      .getByRole("button", { name: "Review saving message", exact: true })
      .click();
    await panel(page)
      .getByRole("heading", {
        name: "Save this message for your Mac",
        exact: true,
      })
      .press("Escape");
    await expect(panel(page)).not.toContainText(secret);
    await refresh(page);
    await expect(panel(page)).toContainText("No messages are listed");
    await panel(page).getByLabel("Message text", { exact: true }).fill(secret);
    await panel(page)
      .getByRole("button", { name: "Review saving message", exact: true })
      .click();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(panel(page)).not.toContainText(secret);
    await expect(
      panel(page).getByLabel("Message text", { exact: true }),
    ).toHaveValue("");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refresh(page);
    await expect(panel(page)).toContainText("No messages are listed");
    await preview(page, info.project.name, "cancelled");
    expect(
      identityServer.events.filter((path) => path.includes("/relay/")),
    ).toEqual([]);
  } finally {
    f.mac.close();
  }
});

test("readable export requires review and local deletion works offline without clearing Mac copies", async ({
  page,
  identityServer,
}, info) => {
  test.setTimeout(60000);
  const f = await ready(page);
  try {
    const envelope = await f.offer.message("SYNTHETIC_ARCHIVE_MESSAGE");
    await importFile(page, envelope);
    await panel(page)
      .getByRole("button", { name: "Review conversation export", exact: true })
      .click();
    await expect(panel(page)).toContainText("readable message content");
    await preview(page, info.project.name, "archive-review");
    const event = page.waitForEvent("download");
    await confirm(page, "Export reviewed conversations");
    const archive = JSON.parse(
      await readFile((await (await event).path())!, "utf8"),
    );
    expect(archive.restoreAuthority).toBe(false);
    expect(archive.items[0].content.content).toBe("SYNTHETIC_ARCHIVE_MESSAGE");
    expect(JSON.stringify(archive)).not.toContain('"key"');
    identityServer.offline(true);
    await panel(page)
      .getByRole("button", { name: "Refresh saved conversations", exact: true })
      .click();
    await expect(panel(page).getByRole("status")).toContainText(
      "local deletion is still available",
    );
    await panel(page)
      .getByRole("button", {
        name: "Review deleting saved conversations",
        exact: true,
      })
      .click();
    await preview(page, info.project.name, "delete-review");
    identityServer.events.length = 0;
    await confirm(page, "Delete reviewed conversations");
    await expect(panel(page).getByRole("status")).toContainText(
      "Saved conversations deleted",
    );
    expect(identityServer.events).toEqual([]);
    identityServer.offline(false);
    await refresh(page);
    await expect(panel(page)).toContainText(
      "Approve conversation access above",
    );
    // The original Mac ciphertext remains available; browser deletion does not retract it.
    expect(await f.offer.original(envelope.header.operationId)).toEqual(
      envelope,
    );
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});

test("a lost final identity response leaves one inspectable saved message and does not retry automatically", async ({
  page,
  identityServer,
}) => {
  test.setTimeout(60000);
  const f = await ready(page);
  try {
    await panel(page)
      .getByLabel("Message text", { exact: true })
      .fill("SYNTHETIC_UNCONFIRMED_SAVE");
    await panel(page)
      .getByRole("button", { name: "Review saving message", exact: true })
      .click();
    // Finish the review's own verified list before counting confirmation calls.
    await expect(
      panel(page).getByRole("heading", {
        name: "Save this message for your Mac",
        exact: true,
      }),
    ).toBeFocused();
    identityServer.reject("/browser/registration/identity", 3);
    await confirm(page, "Save reviewed message");
    await expect(panel(page).getByRole("alert")).toContainText(
      "result was not confirmed",
    );
    await refresh(page);
    expect(
      await panel(page)
        .getByRole("button", { name: /^Open message to mac / })
        .count(),
    ).toBe(1);
    await openFirst(page, "Open message to mac 1");
    await expect(panel(page)).toContainText("SYNTHETIC_UNCONFIRMED_SAVE");
    const envelope = await download(page);
    expect((await f.offer.receive(envelope)).duplicate).toBe(false);
  } finally {
    f.mac.close();
  }
});
