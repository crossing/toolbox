// workerd's `Buffer.prototype.utf8Write` and `Buffer.byteLength` disagree on the
// UTF-8 byte length of a string that contains any multi-byte character.
//
// protobufjs selects its Node-Buffer fast path purely because
// `Buffer.prototype.utf8Write` exists (protobufjs/src/util/minimal.js), and then
// `BufferWriter.prototype.string` sizes a string field with
// `util.Buffer.byteLength(value)` but writes it with `buf.utf8Write(value, pos)`.
// On workerd those two return different byte counts for the same string, so the
// output buffer is allocated a few bytes too short and the write runs past the
// end of it:
//
//   RangeError [ERR_OUT_OF_RANGE]: The value of "length" is out of range.
//   It must be >= 0 && <= 546. Received 552
//     at Uint8Array.utf8Write (node-internal:internal_buffer)
//     at BufferWriter.finish
//     at encodeWAMessage
//     at createParticipantNodes
//
// The visible symptom was `whatsapp_send_message` returning
// `{"ok":false,"detail":"All encryptions failed"}` for every send whose text
// held a non-ASCII byte — a £, an en dash, a curly apostrophe, an accented
// letter. `encodeWAMessage` throws inside `createParticipantNodes`, before
// libsignal is ever reached, which is why the failure looked like an encryption
// failure and reproduced for every recipient including our own device (its
// plaintext, a DeviceSentMessage wrapper, is a different length — hence the two
// different numbers in the two log lines).
//
// Note that simply making `utf8Write` clamp (as Node does when the length
// argument is omitted) is *not* a fix: the buffer is already under-allocated, so
// clamping would silently truncate the message. The sizing is what is wrong.
//
// This patch keeps protobufjs' fast `BufferWriter` for everything else and
// replaces only its string sizing-and-writing with protobufjs' own pure-JS utf8
// module (`@protobufjs/utf8`). Its `length()` and `write()` are the same
// algorithm, so they cannot disagree with each other, and neither touches
// workerd's Buffer. It is a no-op difference on Node (identical bytes), so the
// unit tests exercise exactly the path production runs. Idempotent.
//
// Baileys' generated WAProto imports the same shared `protobufjs/minimal.js`
// singleton this module patches, so importing this module anywhere in the graph
// before the first `encodeWAMessage` — which happens at send time, long after
// every module has loaded — is enough for the fix to take effect.

import $protobuf from "protobufjs/minimal.js";

type Utf8 = {
  length(value: string): number;
  write(value: string, buffer: Uint8Array, offset: number): number;
};

let applied = false;

export function applyProtobufWorkerdFix(): boolean {
  if (applied) return true;

  const BufferWriter = ($protobuf as unknown as { BufferWriter?: { prototype?: Record<string, unknown> } }).BufferWriter;
  const maybeUtf8 = ($protobuf.util as unknown as { utf8?: Utf8 }).utf8;
  if (!BufferWriter?.prototype || !maybeUtf8) return false;
  const utf8: Utf8 = maybeUtf8;

  // Op fn is invoked as fn(val, buf, pos) from Writer.prototype.finish, and the
  // reserved length passed to _push must equal the bytes write() emits.
  function writeStringUtf8(value: string, buffer: Uint8Array, offset: number): void {
    utf8.write(value, buffer, offset);
  }

  BufferWriter.prototype.string = function string_utf8(
    this: { uint32(v: number): unknown; _push(fn: unknown, len: number, val: unknown): unknown },
    value: string,
  ) {
    const len = utf8.length(value);
    this.uint32(len);
    if (len) this._push(writeStringUtf8, len, value);
    return this;
  };

  applied = true;
  return true;
}

applyProtobufWorkerdFix();
