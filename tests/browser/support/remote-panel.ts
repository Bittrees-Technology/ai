import { expect, type Page } from "@playwright/test";
import { Wallet, getBytes, type HDNodeWallet } from "ethers";
const origin = "https://ai.bittrees.org";
declare global {
  interface Window {
    authTestSign: (hex: string) => Promise<string>;
    remoteAuthWalletTest: { change(): void; blur(): void };
  }
}
export async function openRemotePanel(
  page: Page,
  sign?: { entered(): void; wait: Promise<void> },
  wallet: HDNodeWallet = Wallet.createRandom(),
  resume = false,
) {
  await page.exposeBinding("authTestSign", async (_source, hex: string) => {
    sign?.entered();
    if (sign) await sign.wait;
    return wallet.signMessage(getBytes(hex));
  });
  await page.addInitScript((address) => {
    const listeners = new Map<string, (() => void)[]>();
    Object.assign(window, {
      ethereum: {
        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: string[];
        }) =>
          method === "eth_chainId"
            ? "0x1"
            : method === "personal_sign"
              ? window.authTestSign(params![0]!)
              : [address],
        on: (event: string, callback: () => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), callback]);
        },
      },
    });
    window.remoteAuthWalletTest = {
      change: () => {
        for (const fn of listeners.get("accountsChanged") ?? []) fn();
      },
      blur: () => window.dispatchEvent(new Event("blur")),
    };
  }, wallet.address);
  const response = await page.goto(origin + "/remote-panel");
  expect(response?.headers()["content-security-policy"]).toContain(
    "script-src 'self'",
  );
  if (resume)
    await expect(page.locator("#account")).toContainText("Verified wallet:");
  else {
    await expect(
      page.getByRole("button", { name: "Sign in with wallet" }),
    ).toBeEnabled();
    await expect(page.locator("#account")).toHaveText("Not signed in.");
  }
  return wallet;
}
export async function loginRemotePanel(page: Page) {
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect(page.locator("#account")).toContainText("Verified wallet:");
}
export async function expectSignedOut(page: Page) {
  await expect(page.locator("#account")).toHaveText("Not signed in.");
  await expect(
    page.getByRole("button", { name: "Sign in with wallet" }),
  ).toBeEnabled();
  await expect(page.locator("#management")).toBeHidden();
}
