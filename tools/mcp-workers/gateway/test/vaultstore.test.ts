// The account model, which is the part of the vault that decides whose mail a
// tool reads. Gmail and Drive share one Google link but need not share one
// account, and that resolution has three tiers with a fallback at each step.

import { beforeEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vaultstore";
import { makeFakeSql, type FakeSql } from "./sqlfake";

const WORK = "work@example.com";
const HOME = "home@example.net";

describe("VaultStore accounts", () => {
  let sql: FakeSql;
  let vault: VaultStore;

  beforeEach(() => {
    sql = makeFakeSql();
    vault = new VaultStore(sql);
    vault.putAccount("google", WORK, "cipher-work", ["gmail.readonly"]);
    vault.putAccount("google", HOME, "cipher-home", ["drive.readonly"]);
  });

  it("makes the first linked account of a namespace its default", () => {
    expect(vault.getAccount("google")?.label).toBe(WORK);
    expect(vault.listAccounts().filter((a) => a.isDefault).map((a) => a.label)).toEqual([WORK]);
  });

  it("resolves each service to the namespace default until it is pinned", () => {
    expect(vault.getAccountForService("google", "gmail")?.label).toBe(WORK);
    expect(vault.getAccountForService("google", "drive")?.label).toBe(WORK);

    vault.setServiceAccount("drive", "google", HOME);
    // The namespace is the first argument; "drive" names a service, not a
    // namespace, and nothing is linked under it.
    expect(vault.getAccountForService("drive", "drive")).toBeNull();
    expect(vault.getAccountForService("google", "drive")?.label).toBe(HOME);
    // Pinning one service must not move the other.
    expect(vault.getAccountForService("google", "gmail")?.label).toBe(WORK);
    expect(vault.getServiceAccounts()).toEqual({ drive: HOME });
  });

  it("lets an explicit account argument beat both the pin and the default", () => {
    vault.setServiceAccount("drive", "google", HOME);
    expect(vault.getAccountForService("google", "drive", WORK)?.label).toBe(WORK);
    expect(vault.getAccountForService("google", "drive", "nobody@example.com")).toBeNull();
  });

  it("clears a pin when the label is empty", () => {
    vault.setServiceAccount("gmail", "google", HOME);
    expect(vault.getAccountForService("google", "gmail")?.label).toBe(HOME);
    vault.setServiceAccount("gmail", "google", "");
    expect(vault.getServiceAccounts()).toEqual({});
    expect(vault.getAccountForService("google", "gmail")?.label).toBe(WORK);
  });

  it("falls back rather than failing when a pinned account is unlinked", () => {
    vault.setServiceAccount("gmail", "google", HOME);
    vault.deleteAccount("google", HOME);
    // The pin is gone with the account, and gmail keeps working.
    expect(vault.getServiceAccounts()).toEqual({});
    expect(vault.getAccountForService("google", "gmail")?.label).toBe(WORK);
  });

  it("promotes another account when the default is unlinked", () => {
    vault.deleteAccount("google", WORK);
    expect(vault.getAccount("google")?.label).toBe(HOME);
    expect(vault.getAccountForService("google", "gmail")?.label).toBe(HOME);
  });

  it("keeps namespaces apart", () => {
    vault.putAccount("freeagent", "acme", "cipher-fa", []);
    expect(vault.getAccountForService("freeagent", "freeagent")?.label).toBe("acme");
    expect(vault.getAccount("freeagent", WORK)).toBeNull();
    // A pin recorded under one namespace is invisible to another.
    vault.setServiceAccount("gmail", "google", HOME);
    expect(vault.getAccountForService("freeagent", "gmail")?.label).toBe("acme");
  });

  it("relinking replaces the grant without disturbing the defaults", () => {
    vault.setDefaultAccount("google", HOME);
    vault.putAccount("google", WORK, "cipher-work-2", ["gmail.modify"]);
    expect(vault.getAccount("google", WORK)?.ciphertext).toBe("cipher-work-2");
    expect(vault.getAccount("google")?.label).toBe(HOME);
    expect(vault.listAccounts().find((a) => a.label === WORK)?.scopes).toEqual(["gmail.modify"]);
  });
});

describe("VaultStore services and audit", () => {
  it("falls back to the code-side default until a toggle is written", () => {
    const vault = new VaultStore(makeFakeSql());
    expect(vault.isServiceEnabled("whatsapp", false)).toBe(false);
    vault.setServiceEnabled("whatsapp", true);
    expect(vault.isServiceEnabled("whatsapp", false)).toBe(true);
    expect(vault.getCatalogConfig({ gmail: true, whatsapp: false }).services).toEqual({
      gmail: true,
      whatsapp: true,
    });
  });

  it("returns the newest audit entries first", () => {
    const vault = new VaultStore(makeFakeSql());
    for (const tool of ["a", "b", "c"]) {
      vault.appendAudit({ ts: 1, tool, summary: "{}", status: "ok" });
    }
    expect(vault.listAudit(2).map((e) => e.tool)).toEqual(["c", "b"]);
  });
});
