import { test, expect, type Page, type Download } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const make = () => ({
  owner: "synthetic:" + randomUUID(),
  binding: {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: Date.now() + 3600000,
  },
  now: Date.now(),
});
async function init(page: Page, f = make()) {
  await page.goto("/?browser-key-controls");
  await page.waitForFunction(() => !!window.browserKeyControlsTest);
  await page.evaluate(
    (f) => window.browserKeyControlsTest.init(f.owner, f.binding, f.now),
    f,
  );
  await page.bringToFront();
  await refresh(page);
  return f;
}
async function refresh(page: Page) {
  await page.getByRole("button", { name: "Refresh keys", exact: true }).click();
  await expect(page.getByRole("status")).not.toContainText("Loading");
}
async function review(page: Page, action: string, confirmation: string) {
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(
    page.getByRole("button", { name: confirmation, exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "I understand this exact change." })
    .check();
  await page.getByRole("button", { name: confirmation, exact: true }).click();
}
async function downloadText(download: Download) {
  return readFile((await download.path())!, "utf8");
}
async function start(page: Page) {
  await review(page, "Review new key", "Confirm start key setup");
  await expect(
    page.getByRole("region", { name: "Save recovery code", exact: true }),
  ).toBeVisible();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download recovery code", exact: true })
    .click();
  const code = (await downloadText(await pending)).trim();
  expect(code).toMatch(/^btre1_[A-Za-z0-9_-]{43}$/);
  return code;
}
async function prepare(page: Page, code: string) {
  await page
    .getByLabel("Recovery code from your saved copy", { exact: true })
    .fill(code);
  await page
    .getByRole("checkbox", { name: "I saved this recovery code separately." })
    .check();
  await page
    .getByRole("button", { name: "Prepare encrypted backup", exact: true })
    .click();
  await expect(
    page.getByRole("region", {
      name: "Check backup before activation",
      exact: true,
    }),
  ).toBeVisible();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Download this encrypted backup",
      exact: true,
    })
    .click();
  return JSON.parse(await downloadText(await pending));
}
async function select(page: Page, kit: unknown, check = false) {
  await page
    .getByLabel(
      check ? "Encrypted backup to check" : "Saved encrypted backup file",
      { exact: true },
    )
    .setInputFiles({
      name: "saved-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(kit)),
    });
  await expect(
    page.getByLabel(
      check ? "Recovery code to check" : "Recovery code for activation",
      { exact: true },
    ),
  ).toBeEnabled();
}
async function activate(page: Page, code: string, kit: unknown) {
  await select(page, kit);
  await page
    .getByLabel("Recovery code for activation", { exact: true })
    .fill(code);
  await page
    .getByRole("checkbox", {
      name: "I saved both recovery items in separate places.",
    })
    .check();
  await page
    .getByRole("button", { name: "Check backup and activate key", exact: true })
    .click();
}
async function prepared(page: Page) {
  const f = await init(page),
    code = await start(page),
    kit = await prepare(page, code);
  return { f, code, kit };
}
async function active(page: Page) {
  const x = await prepared(page);
  await activate(page, x.code, x.kit);
  await expect(page.getByRole("status")).toContainText("Browser key ready");
  return x;
}
const state = (page: Page) =>
  page.evaluate(() => window.browserKeyControlsTest.status());
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});
test("Saved file and code precede activation; reload retains the same key; backup checking restores no authority", async ({
  page,
}) => {
  const { f, code, kit } = await prepared(page);
  expect((await state(page)).slots[0]?.state).toBe("preparing");
  await expect(
    page.evaluate(() => window.browserKeyControlsTest.resolve()),
  ).rejects.toThrow("DENIED");
  await expect(
    page.getByRole("button", { name: "Check backup and activate key" }),
  ).toBeDisabled();
  expect(JSON.stringify(kit)).not.toContain(code);
  await activate(page, code, kit);
  await expect(page.getByRole("status")).toContainText("Browser key ready");
  const proof = await page.evaluate(() =>
    window.browserKeyControlsTest.resolve(),
  );
  await init(page, f);
  expect(
    await page.evaluate(() => window.browserKeyControlsTest.resolve()),
  ).toEqual(proof);
  const before = await state(page);
  await page
    .getByRole("button", { name: "Check a saved backup", exact: true })
    .click();
  await select(page, kit, true);
  await page.getByLabel("Recovery code to check", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Check saved items" }).click();
  await expect(page.getByText(/Backup checked\. Key/)).toBeVisible();
  await expect(
    page.getByLabel("Recovery code to check", { exact: true }),
  ).toHaveValue("");
  expect(await state(page)).toEqual(before);
});
test("Wrong saved code and mismatched encrypted kit cannot activate or overwrite prepared material", async ({
  page,
}) => {
  const { code, kit } = await prepared(page),
    before = await state(page);
  const wrong = await page.evaluate(() => window.browserKeyControlsTest.code());
  await activate(page, wrong, kit);
  await expect(page.getByRole("alert")).toContainText("not confirmed");
  expect(await state(page)).toEqual(before);
  const slot = before.slots[0]!;
  await expect(
    page.evaluate(
      ({ slot, code, kit, revision }) =>
        window.browserKeyControlsTest.activate(
          {
            keyId: slot.id,
            expectedRevision: revision,
            confirmed: true,
            recoverySaved: true,
          },
          code,
          { ...kit, iv: (kit.iv[0] === "A" ? "B" : "A") + kit.iv.slice(1) },
        ),
      { slot, code, kit, revision: before.revision },
    ),
  ).rejects.toThrow();
  expect(
    await page.evaluate((id) => window.browserKeyControlsTest.kit(id), slot.id),
  ).toEqual(kit);
  await refresh(page);
  await review(page, "Resume setup", "Confirm resume key setup");
  await expect(
    page.getByRole("button", { name: "Reveal recovery code" }),
  ).toBeDisabled();
  expect(await prepare(page, code)).toEqual(kit);
  await activate(page, code, kit);
  await expect(page.getByRole("status")).toContainText("Browser key ready");
});
test("Blur hides code, clears saved inputs and revokes download URLs without regenerating", async ({
  page,
}) => {
  await init(page);
  const code = await start(page);
  await page
    .getByRole("button", { name: "Reveal recovery code", exact: true })
    .click();
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveValue(
    code,
  );
  await page
    .getByLabel("Recovery code from your saved copy", { exact: true })
    .fill(code);
  await page
    .getByRole("checkbox", { name: "I saved this recovery code separately." })
    .check();
  expect(
    await page.evaluate(() => window.browserKeyControlsTest.urls()),
  ).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByLabel("Recovery code from your saved copy", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("checkbox", {
      name: "I saved this recovery code separately.",
    }),
  ).not.toBeChecked();
  expect(await page.evaluate(() => window.browserKeyControlsTest.urls())).toBe(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Reveal recovery code", exact: true }),
  ).toBeDisabled();
  const kit = await prepare(page, code);
  await activate(page, code, kit);
  await expect(page.getByRole("status")).toContainText("Browser key ready");
  expect((await state(page)).slots).toHaveLength(1);
});
test("Returning from a file-picker blur requires re-entry and saved-item confirmation", async ({
  page,
}) => {
  const { code, kit } = await prepared(page);
  await page
    .getByLabel("Recovery code for activation", { exact: true })
    .fill(code);
  await page
    .getByRole("checkbox", {
      name: "I saved both recovery items in separate places.",
    })
    .check();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await select(page, kit);
  await expect(
    page.getByLabel("Recovery code for activation", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("checkbox", {
      name: "I saved both recovery items in separate places.",
    }),
  ).not.toBeChecked();
  await page
    .getByLabel("Recovery code for activation", { exact: true })
    .fill(code);
  await page
    .getByRole("checkbox", {
      name: "I saved both recovery items in separate places.",
    })
    .check();
  await page
    .getByRole("button", { name: "Check backup and activate key" })
    .click();
  await expect(page.getByRole("status")).toContainText("Browser key ready");
});
test("Expired review and changed identity clear the flow and do not activate", async ({
  page,
}) => {
  const { f, code } = await prepared(page);
  await page
    .getByLabel("Recovery code for activation", { exact: true })
    .fill(code);
  await page.evaluate(
    (t) => window.browserKeyControlsTest.time(t),
    f.now + 120001,
  );
  await expect(page.getByRole("status")).toContainText("Review expired");
  await expect(
    page.getByLabel("Recovery code for activation", { exact: true }),
  ).toHaveValue("");
  expect((await state(page)).slots[0]?.state).toBe("preparing");
  await refresh(page);
  await review(page, "Resume setup", "Confirm resume key setup");
  await page.evaluate(() =>
    window.browserKeyControlsTest.scope("different-session"),
  );
  await expect(page.getByRole("status")).toContainText(
    "Account or access changed",
  );
  await expect(
    page.getByRole("list", { name: "Browser key history" }),
  ).toBeEmpty();
  expect((await state(page)).slots[0]?.state).toBe("preparing");
});
test("A competing tab invalidates the exact prepared revision without an automatic retry", async ({
  page,
}) => {
  const { code, kit } = await prepared(page);
  await page.evaluate(() => window.browserKeyControlsTest.replace());
  await activate(page, code, kit);
  await expect(page.getByRole("alert")).toContainText("review changed");
  const s = await state(page);
  expect(s.slots.map((s) => s.state)).toEqual(["retired", "preparing"]);
  expect(
    (await page.evaluate(() => window.browserKeyControlsTest.calls())).filter(
      (x) => x === "activate",
    ),
  ).toHaveLength(1);
});
test("Late preparation does not reopen secrets or destroy a newer review", async ({
  page,
}) => {
  await init(page);
  const code = await start(page);
  await page.evaluate(() => window.browserKeyControlsTest.hold("prepare"));
  await page
    .getByLabel("Recovery code from your saved copy", { exact: true })
    .fill(code);
  await page
    .getByRole("checkbox", { name: "I saved this recovery code separately." })
    .check();
  await page.getByRole("button", { name: "Prepare encrypted backup" }).click();
  await page.waitForFunction(() => window.browserKeyControlsTest.held());
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await refresh(page);
  await page.getByRole("button", { name: "Resume setup" }).click();
  await page.evaluate(() => window.browserKeyControlsTest.release());
  await expect(
    page.getByRole("region", { name: "Review key change", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: "Check backup before activation",
      exact: true,
    }),
  ).toBeHidden();
  expect((await state(page)).slots[0]?.state).toBe("preparing");
});
test("Committed deletion clears stale history even if refresh fails, and late refresh cannot replace a new identity notice", async ({
  page,
}) => {
  await active(page);
  await page.evaluate(() => window.browserKeyControlsTest.failStatus());
  await review(page, "Review key deletion", "Confirm delete key");
  await expect(page.getByRole("status")).toContainText(
    "Key material deleted locally",
  );
  await expect(page.getByRole("alert")).toContainText("storage is unavailable");
  await expect(
    page.getByRole("list", { name: "Browser key history" }),
  ).toBeEmpty();
  expect((await state(page)).slots[0]?.state).toBe("deleted");
  await refresh(page);
  await page.evaluate(() => window.browserKeyControlsTest.hold("status"));
  await page.getByRole("button", { name: "Refresh keys", exact: true }).click();
  await page.waitForFunction(() => window.browserKeyControlsTest.held());
  await page.evaluate(() =>
    window.browserKeyControlsTest.scope("new-owner-session"),
  );
  await page.evaluate(() => window.browserKeyControlsTest.release());
  await expect(page.getByRole("status")).toContainText(
    "Account or access changed",
  );
  await expect(
    page.getByRole("list", { name: "Browser key history" }),
  ).toBeEmpty();
});
test("Offline export and stop preserve backup; clear deletes material and requires a different fresh browser", async ({
  page,
}) => {
  const { f, kit } = await active(page);
  await page.evaluate(() => window.browserKeyControlsTest.set(null, false));
  await refresh(page);
  await expect(
    page.getByRole("button", { name: "Review new key", exact: true }),
  ).toBeDisabled();
  await review(page, "Review stop using key", "Confirm stop using key");
  await expect(page.getByRole("status")).toContainText("Key stopped locally");
  expect((await state(page)).slots[0]?.state).toBe("retired");
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download encrypted backup", exact: true })
    .click();
  expect(JSON.parse(await downloadText(await pending))).toEqual(kit);
  await review(
    page,
    "Review deletion of all keys",
    "Confirm delete all browser keys",
  );
  await expect(page.getByRole("status")).toContainText(
    "Key material deleted locally",
  );
  expect((await state(page)).locked).toBe(true);
  await page.evaluate(
    (b) => window.browserKeyControlsTest.set(b, true),
    f.binding,
  );
  await refresh(page);
  await review(
    page,
    "Review new registration",
    "Confirm use new browser registration",
  );
  await expect(page.getByRole("alert")).not.toBeEmpty();
  await page.evaluate((b) => window.browserKeyControlsTest.set(b, true), {
    ...f.binding,
    deviceId: randomUUID(),
  });
  await refresh(page);
  await review(
    page,
    "Review new registration",
    "Confirm use new browser registration",
  );
  await expect(page.getByRole("status")).toContainText(
    "New registration selected",
  );
  await expect(
    page.getByRole("button", { name: "Review new key", exact: true }),
  ).toBeEnabled();
});
test("Malformed or foreign-owner backups never expose recovered identity or restore state", async ({
  page,
}) => {
  const { code, kit } = await active(page);
  const other = make();
  await init(page, other);
  await page
    .getByRole("button", { name: "Check a saved backup", exact: true })
    .click();
  await select(page, { invalid: true }, true);
  await expect(page.getByRole("alert")).not.toBeEmpty();
  await select(page, kit, true);
  await page.getByLabel("Recovery code to check", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Check saved items" }).click();
  await expect(page.getByRole("alert")).toContainText("not confirmed");
  await expect(page.getByText(/Backup checked\. Key/)).toHaveCount(0);
  expect((await state(page)).slots).toHaveLength(0);
});
test("Keyboard escape and disposal clear code and cancel late downloads", async ({
  page,
}) => {
  await init(page);
  await start(page);
  await page
    .getByRole("button", { name: "Reveal recovery code", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveValue(
    "",
  );
  expect(await page.evaluate(() => window.browserKeyControlsTest.urls())).toBe(
    0,
  );
  await refresh(page);
  await page.getByRole("button", { name: "Review key deletion" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Delete key", exact: true }),
  ).toBeFocused();
  await page.evaluate(() => window.browserKeyControlsTest.destroy());
  await expect(
    page.getByRole("region", { name: "Browser keys and recovery" }),
  ).toHaveCount(0);
});
for (const width of [1200, 390])
  test(`Key setup, activation and deletion review fit ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 960 });
    const { code, kit } = await prepared(page);
    const shot = async (name: string) => {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/browser-key-controls-${name}-${width}-${info.project.name}.png`,
        fullPage: true,
      });
    };
    await shot("backup");
    await activate(page, code, kit);
    await expect(page.getByRole("status")).toContainText("Browser key ready");
    await shot("ready");
    await page.getByRole("button", { name: "Review key deletion" }).click();
    await shot("delete");
  });

test("Prepared activation requires exact revision, saved acknowledgment and matching kit; it cannot be replayed", async ({
  page,
}) => {
  const { code, kit } = await prepared(page),
    before = await state(page),
    id = before.slots[0]!.id;
  for (const raw of [
    {
      keyId: id,
      expectedRevision: before.revision,
      confirmed: true,
      recoverySaved: false,
    },
    {
      keyId: id,
      expectedRevision: before.revision + 1,
      confirmed: true,
      recoverySaved: true,
    },
    {
      keyId: randomUUID(),
      expectedRevision: before.revision,
      confirmed: true,
      recoverySaved: true,
    },
  ]) {
    await expect(
      page.evaluate(
        ({ raw, code, kit }) =>
          window.browserKeyControlsTest.activate(raw, code, kit),
        { raw, code, kit },
      ),
    ).rejects.toThrow();
    expect(await state(page)).toEqual(before);
  }
  await activate(page, code, kit);
  await expect(page.getByRole("status")).toContainText("Browser key ready");
  const after = await state(page);
  await expect(
    page.evaluate(
      ({ id, revision, code, kit }) =>
        window.browserKeyControlsTest.activate(
          {
            keyId: id,
            expectedRevision: revision,
            confirmed: true,
            recoverySaved: true,
          },
          code,
          kit,
        ),
      { id, revision: before.revision, code, kit },
    ),
  ).rejects.toThrow("CONFLICT");
  expect(await state(page)).toEqual(after);
});
test("Reload resumes the original prepared key using the original code and backup", async ({
  page,
}) => {
  const { f, code, kit } = await prepared(page),
    before = await state(page);
  await init(page, f);
  await review(page, "Resume setup", "Confirm resume key setup");
  const restored = await prepare(page, code);
  expect(restored).toEqual(kit);
  expect(await state(page)).toEqual(before);
  await activate(page, code, restored);
  await expect(page.getByRole("status")).toContainText("Browser key ready");
  expect((await state(page)).slots[0]!.id).toBe(before.slots[0]!.id);
});
test("A late post-activation refresh cannot announce success under a new identity", async ({
  page,
}) => {
  const { code, kit } = await prepared(page);
  await page.evaluate(() => window.browserKeyControlsTest.hold("status"));
  await activate(page, code, kit);
  await page.waitForFunction(() => window.browserKeyControlsTest.held());
  await page.evaluate(() =>
    window.browserKeyControlsTest.scope("replacement-identity"),
  );
  await page.evaluate(() => window.browserKeyControlsTest.release());
  await expect(page.getByRole("status")).toContainText(
    "Account or access changed",
  );
  await expect(
    page.getByRole("list", { name: "Browser key history" }),
  ).toBeEmpty();
  expect((await state(page)).slots[0]!.state).toBe("active");
  await refresh(page);
  await expect(
    page.getByText("Ready for pairing", { exact: true }),
  ).toBeVisible();
});
test("Hidden page clears recovery inputs and destruction suppresses a late backup download", async ({
  page,
}) => {
  const { code } = await prepared(page);
  await page
    .getByLabel("Recovery code for activation", { exact: true })
    .fill(code);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByLabel("Recovery code for activation", { exact: true }),
  ).toHaveValue("");
  await page.evaluate(() => {
    delete (document as any).visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.browserKeyControlsTest.hold("export");
  });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page
    .getByRole("button", { name: "Download this encrypted backup" })
    .click();
  await page.waitForFunction(() => window.browserKeyControlsTest.held());
  await page.evaluate(() => {
    window.browserKeyControlsTest.destroy();
    window.browserKeyControlsTest.release();
  });
  // Drain the queued browser task after the held callback without a timed sleep.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  expect(downloads).toBe(0);
  expect(await page.evaluate(() => window.browserKeyControlsTest.urls())).toBe(
    0,
  );
});
