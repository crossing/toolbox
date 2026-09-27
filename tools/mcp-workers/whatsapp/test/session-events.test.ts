// The Session's wiring from Baileys events to the bridge's handlers, driven
// through a socket stand-in. The handlers' own behaviour is covered elsewhere;
// this checks that the events reach them at all, and in the shape they expect
// — a group receipt in particular arrives on a different event with a
// timestamp instead of a status, and the store has to be given a status.

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sockets: FakeSocket[] = [];

class FakeSocket {
  ev = Object.assign(new EventEmitter(), { flush: () => {} });
  ws = new EventEmitter();
  ended = false;
  end() {
    this.ended = true;
  }
}

vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("baileys")>();
  return {
    ...actual,
    default: () => {
      const sock = new FakeSocket();
      sockets.push(sock);
      return sock;
    },
  };
});

const { proto } = await import("baileys");
const { Session } = await import("../src/session");

function open(handlers: Partial<import("../src/session").SessionHandlers> = {}) {
  const log = vi.fn();
  const session = new Session({
    auth: { state: { creds: {}, keys: {} } } as never,
    onCreds: () => {},
    onMessages: () => {},
    onChats: () => {},
    log,
    ...handlers,
  });
  return { session, sock: sockets[sockets.length - 1]!, log };
}

describe("Session event wiring", () => {
  beforeEach(() => sockets.splice(0));

  it("hands messages.update to the bridge as it came", () => {
    const onMessageUpdates = vi.fn();
    const { sock } = open({ onMessageUpdates });
    const updates = [{ key: { remoteJid: "447700900111@s.whatsapp.net", fromMe: true, id: "M1" }, update: { status: 4 } }];
    sock.ev.emit("messages.update", updates);
    expect(onMessageUpdates).toHaveBeenCalledWith(updates);
  });

  it("turns a group member's receipt into the status it amounts to", () => {
    const onMessageUpdates = vi.fn();
    const { sock } = open({ onMessageUpdates });
    const key = { remoteJid: "120363000000000001@g.us", fromMe: true, id: "G1" };
    sock.ev.emit("message-receipt.update", [
      { key, receipt: { userJid: "447700900111@s.whatsapp.net", readTimestamp: 1758283200 } },
      { key, receipt: { userJid: "447700900222@s.whatsapp.net", receiptTimestamp: 1758283100 } },
    ]);
    expect(onMessageUpdates).toHaveBeenCalledWith([
      { key, update: { status: proto.WebMessageInfo.Status.READ } },
      { key, update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK } },
    ]);
  });

  it("a handler that throws is logged, not fatal to the socket", () => {
    const { sock, log } = open({
      onMessageUpdates: () => {
        throw new Error("no such column");
      },
    });
    sock.ev.emit("messages.update", [{ key: { id: "M1" }, update: { status: 4 } }]);
    expect(log).toHaveBeenCalledWith("error", expect.stringContaining("no such column"));
  });

  it("does nothing for an empty batch, or when the bridge did not ask", () => {
    const onMessageUpdates = vi.fn();
    const first = open({ onMessageUpdates });
    first.sock.ev.emit("messages.update", []);
    expect(onMessageUpdates).not.toHaveBeenCalled();
    const second = open();
    expect(() => second.sock.ev.emit("message-receipt.update", [{ key: { id: "X" }, receipt: {} }])).not.toThrow();
  });
});
