// The protobufjs BufferWriter string bug that surfaced as "All encryptions
// failed" on every WhatsApp send whose text held a multi-byte character.
//
// Root cause (from the production stack trace): protobufjs' `BufferWriter`
// sizes a string field with `util.Buffer.byteLength(value)` but writes it with
// `buf.utf8Write(value, pos)`. On edge workerd those two disagree on the UTF-8
// byte length of a string with any multi-byte char, so the output buffer is
// allocated a few bytes short and the write throws
// `RangeError [ERR_OUT_OF_RANGE]` inside `encodeWAMessage` — before libsignal
// is reached. Local wrangler-dev's workerd does not have the discrepancy, so
// this test *induces* it deterministically by making protobufjs' `util.Buffer`
// report a too-small byteLength (scoped to protobufjs; the global Buffer is
// untouched), which is exactly the shape the edge build hit.

import { describe, expect, it } from "vitest";
import $protobuf from "protobufjs/minimal.js";
import { applyProtobufWorkerdFix } from "../src/protobuf-workerd-fix";
import { proto } from "baileys";

// Idempotent; also auto-applied when the module is imported.
applyProtobufWorkerdFix();

// ~500 chars with the multi-byte characters that show up in real messages:
// £ (2 bytes), en dash – and em dash — (3), curly apostrophe ’ (3), accents.
const MULTIBYTE =
  "Balance due £1,240.50 — please confirm you’ve received it. Café, résumé, £732 – naïve façade. ".repeat(6);

function encodeDecodeConversation(text: string): string {
  const bytes = proto.Message.encode({ conversation: text }).finish();
  return proto.Message.decode(bytes).conversation!;
}

// Swap protobufjs' Buffer for one whose byteLength under-reports multi-byte
// strings (returns the char count), leaving alloc/from and the global Buffer
// alone. Restores on the way out.
function withUnderreportingByteLength<T>(fn: () => T): T {
  const util = ($protobuf as unknown as { util: { Buffer: any } }).util;
  const realBuffer = util.Buffer;
  util.Buffer = new Proxy(realBuffer, {
    get(target, prop, recv) {
      if (prop === "byteLength") {
        return (value: unknown, enc?: BufferEncoding) =>
          typeof value === "string" ? value.length : realBuffer.byteLength(value, enc);
      }
      return Reflect.get(target, prop, recv);
    },
  });
  try {
    return fn();
  } finally {
    util.Buffer = realBuffer;
  }
}

describe("protobuf-workerd-fix", () => {
  it("round-trips a multi-byte string through the Buffer writer", () => {
    expect(encodeDecodeConversation(MULTIBYTE)).toBe(MULTIBYTE);
  });

  it("stays correct even when Buffer.byteLength under-reports (the edge-workerd defect)", () => {
    // The patched BufferWriter.string sizes with protobufjs' own util.utf8.length,
    // not Buffer.byteLength, so a broken byteLength cannot under-allocate.
    withUnderreportingByteLength(() => {
      expect(encodeDecodeConversation(MULTIBYTE)).toBe(MULTIBYTE);
    });
  });

  it("proves the stock BufferWriter.string is the failing path the fix replaces", () => {
    // Reinstate protobufjs' original string impl and show it corrupts or throws
    // under the same under-reporting byteLength — the production failure mode.
    const $p = $protobuf as any;
    const BW = $p.BufferWriter;
    const util = $p.util;
    const patched = BW.prototype.string;
    BW.prototype.string = function stockString(this: any, value: string) {
      const len = util.Buffer.byteLength(value);
      this.uint32(len);
      if (len) {
        this._push(function writeStringBuffer(val: string, buf: any, pos: number) {
          if (val.length < 40) util.utf8.write(val, buf, pos);
          else if (buf.utf8Write) buf.utf8Write(val, pos);
          else buf.write(val, pos);
        }, len, value);
      }
      return this;
    };
    try {
      let threw = false;
      let result: string | undefined;
      withUnderreportingByteLength(() => {
        try {
          result = encodeDecodeConversation(MULTIBYTE);
        } catch {
          // Edge workerd throws ERR_OUT_OF_RANGE here; Node clamps and truncates.
          threw = true;
        }
      });
      expect(threw || result !== MULTIBYTE).toBe(true);
    } finally {
      BW.prototype.string = patched;
    }
    // And the fix is back in force for anything after.
    expect(encodeDecodeConversation(MULTIBYTE)).toBe(MULTIBYTE);
  });

  it("is idempotent", () => {
    expect(applyProtobufWorkerdFix()).toBe(true);
    expect(applyProtobufWorkerdFix()).toBe(true);
  });
});
