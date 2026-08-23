// The ordering rules a WhatsApp connection actually follows, as opposed to the
// ones it would be convenient for it to follow.

import { describe, expect, it } from "vitest";
import { ConnectionWaiters, isFatalDisconnect, DisconnectReason } from "../src/session";

describe("ConnectionWaiters", () => {
  it("matches state that arrived before the waiter did", async () => {
    const waiters = new ConnectionWaiters();
    // The real sequence from a reconnecting device: drained at 12:57:02.259,
    // open at 12:57:02.346. Code that awaits open first must still see it.
    waiters.settle({ receivedPendingNotifications: true });
    waiters.settle({ connection: "open" });

    await expect(waiters.wait((u) => u.connection === "open", 50)).resolves.toBeTruthy();
    await expect(waiters.wait((u) => u.receivedPendingNotifications === true, 50)).resolves.toBeTruthy();
  });

  it("still waits for what has not happened", async () => {
    const waiters = new ConnectionWaiters();
    waiters.settle({ connection: "connecting" });
    const drained = waiters.wait((u) => u.receivedPendingNotifications === true, 1000);
    waiters.settle({ receivedPendingNotifications: true });
    await expect(drained).resolves.toBeTruthy();
  });

  it("times out with a message naming the wait", async () => {
    const waiters = new ConnectionWaiters();
    await expect(waiters.wait((u) => u.connection === "open", 20)).rejects.toThrow(/timed out after 0s/);
  });

  it("rejects an outstanding waiter when the connection closes", async () => {
    const waiters = new ConnectionWaiters();
    waiters.closeReason = () => "connection closed (515: restart required)";
    const opened = waiters.wait((u) => u.connection === "open", 1000);
    waiters.settle({ connection: "close" });
    await expect(opened).rejects.toThrow(/515/);
  });

  it("rejects a waiter registered after the close, unless it opts out", async () => {
    const waiters = new ConnectionWaiters();
    waiters.closeReason = () => "connection closed (401: logged out)";
    waiters.settle({ connection: "close" });
    await expect(waiters.wait((u) => u.connection === "open", 20)).rejects.toThrow(/401/);
    // The pairing flow waits *for* the close, so it must be able to see one
    // that already happened.
    await expect(
      waiters.wait((u) => u.connection === "close", 20, { rejectOnClose: false }),
    ).resolves.toBeTruthy();
  });

  it("keeps the latest value of a field that is emitted more than once", async () => {
    const waiters = new ConnectionWaiters();
    waiters.settle({ receivedPendingNotifications: false });
    waiters.settle({ connection: "open" });
    const pending = waiters.wait((u) => u.receivedPendingNotifications === true, 1000);
    waiters.settle({ receivedPendingNotifications: true });
    await expect(pending).resolves.toBeTruthy();
  });

  it("stops waiting once cancelled", async () => {
    const waiters = new ConnectionWaiters();
    const opened = waiters.wait((u) => u.connection === "open", 30);
    waiters.cancelAll();
    // The timer is gone, so this rejects on nothing and the test would hang
    // rather than fail if cancelAll leaked it.
    waiters.settle({ connection: "open" });
    await expect(Promise.race([opened, new Promise((r) => setTimeout(() => r("still pending"), 60))])).resolves.toBe(
      "still pending",
    );
  });
});

describe("isFatalDisconnect", () => {
  it("is fatal only when the credentials are actually dead", () => {
    expect(isFatalDisconnect(DisconnectReason.loggedOut)).toBe(true);
    expect(isFatalDisconnect(DisconnectReason.forbidden)).toBe(true);
    expect(isFatalDisconnect(DisconnectReason.multideviceMismatch)).toBe(true);
    // 440 means another client took the session — transient, and the one code
    // that must never disable scheduled syncing.
    expect(isFatalDisconnect(DisconnectReason.connectionReplaced)).toBe(false);
    expect(isFatalDisconnect(DisconnectReason.restartRequired)).toBe(false);
    expect(isFatalDisconnect(DisconnectReason.connectionClosed)).toBe(false);
    expect(isFatalDisconnect(null)).toBe(false);
  });
});
