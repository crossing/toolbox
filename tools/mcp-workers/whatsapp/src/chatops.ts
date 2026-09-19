// Archive, delete-chat and revoke — the operations that change what WhatsApp
// shows without the bridge ever forgetting anything. Kept apart from the socket,
// like groups.ts, so each decision is unit-tested against a fake.
//
// The standing rule, because it is the reason this module is shaped the way it
// is: **nothing here removes a row.** Deleting a chat deletes it on WhatsApp and
// flags it in the store; revoking a message withdraws it for everyone and flags
// the row. The second brain keeps what was said.
//
// Archive and delete are not stanzas addressed to the chat. They are *app-state
// patches*: an encrypted mutation to the account's synced state, which the phone
// and every other linked device then apply. Baileys builds one in `chatModify` →
// `appPatch` (Socket/chats.js), which needs an app-state sync key from the phone
// (see auth.ts `appStateProblem`) and resyncs the collection before encoding.
// Either the patch is accepted by the server or `chatModify` throws — there is
// no quiet path, and a flag is only written after it returns.

import { jidNormalizedUser } from "baileys";
import type { proto } from "baileys";
import type { ArchiveChatResult, DeleteChatResult, RevokeMessageResult } from "@toolbox/mcp-shared";
import { normalizeJid, type Store } from "./store";

type MessageRange = proto.SyncActionValue.ISyncActionMessageRange;

/** The slice of a Baileys socket these operations need; faked in the tests. */
export interface ChatOpsSocket {
  chatModify(
    mod: { archive: boolean; lastMessages: MessageRange } | { delete: true; lastMessages: MessageRange },
    jid: string,
  ): Promise<void>;
  sendMessage(
    jid: string,
    content: { delete: { remoteJid: string; fromMe: boolean; id: string; participant?: string } },
  ): Promise<unknown>;
}

/**
 * WhatsApp lets a sender delete for everyone for "about two days"; clients
 * enforce it, the server does not. Past the window the revoke is sent, accepted
 * and ignored by every recipient — a success that changed nothing. Refuse
 * instead, a little inside the limit, so the store never claims a withdrawal
 * that did not happen.
 */
export const REVOKE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * The message range an archive or delete has to carry: the chat's newest
 * message, by key and time, which is how the phone decides what the action
 * covers (a message that arrives after it is not swept up by it).
 *
 * Built as the proto range itself rather than as Baileys' `MinimalMessage[]`.
 * `chatModificationToAppPatch` (Utils/chat-utils.js) passes a given range
 * through untouched, but maps a message list by returning each message as it
 * is — leaving `timestamp`, the field the proto actually has, unset. Baileys'
 * own checks on that path are repeated here: a complete key, a timestamp, and a
 * participant on a group message someone else wrote.
 *
 * An empty chat is legitimate — a group created a minute ago, nothing said. The
 * range then carries only a timestamp, the chat's own, as WhatsApp Web does.
 */
export function messageRangeFor(store: Store, chatJid: string, now = Date.now()): { range: MessageRange; empty: boolean } {
  const jid = normalizeJid(chatJid);
  const last = store.lastMessageKey(jid);
  if (!last) {
    const chatTime = store.getChat(jid)?.lastMessageTime;
    const seconds = Math.floor((chatTime ? new Date(chatTime).getTime() : now) / 1000);
    return { range: { lastMessageTimestamp: seconds, messages: [] }, empty: true };
  }
  if (!last.timestampSeconds) throw new Error(`the newest stored message in ${jid} has no usable timestamp`);
  return {
    range: {
      lastMessageTimestamp: last.timestampSeconds,
      messages: [
        {
          key: {
            remoteJid: jid,
            fromMe: last.fromMe,
            id: last.id,
            ...(last.participant ? { participant: jidNormalizedUser(last.participant) || last.participant } : {}),
          },
          timestamp: last.timestampSeconds,
        },
      ],
    },
    empty: false,
  };
}

/** Archive or unarchive. The flag is written only once WhatsApp took the patch. */
export async function archiveChatOnSocket(
  sock: ChatOpsSocket,
  store: Store,
  chatJid: string,
  archive: boolean,
): Promise<ArchiveChatResult> {
  const jid = normalizeJid(chatJid);
  const { range, empty } = messageRangeFor(store, jid);
  await sock.chatModify({ archive, lastMessages: range }, jid);
  store.setArchived(jid, archive);
  return { ok: true, chatJid: jid, archived: archive, ...(empty ? { emptyChat: true } : {}) };
}

/**
 * Delete the chat on WhatsApp; keep every message here. `messagesKept` is
 * counted after the flag is written, so the result states what survived rather
 * than what was expected to.
 */
export async function deleteChatOnSocket(
  sock: ChatOpsSocket,
  store: Store,
  chatJid: string,
  now: () => Date = () => new Date(),
): Promise<DeleteChatResult> {
  const jid = normalizeJid(chatJid);
  const { range } = messageRangeFor(store, jid, now().getTime());
  await sock.chatModify({ delete: true, lastMessages: range }, jid);
  const deletedAt = now().toISOString();
  store.markChatDeleted(jid, deletedAt);
  return { ok: true, chatJid: jid, deletedAt, messagesKept: store.countMessages(jid) };
}

/**
 * Everything that can be decided about a revoke before a socket is opened.
 * Throws with a message fit for the caller.
 */
export function checkRevocable(store: Store, chatJid: string, messageId: string, now = Date.now()): void {
  const facts = store.messageFacts(chatJid, messageId);
  if (!facts) {
    throw new Error(`no message ${messageId} in ${normalizeJid(chatJid)} — both ids come from whatsapp_list_messages`);
  }
  if (!facts.isFromMe) {
    throw new Error("that message was written by someone else; only this account's own messages can be deleted for everyone");
  }
  if (facts.revokedAt) throw new Error(`that message was already deleted for everyone at ${facts.revokedAt}`);
  const age = now - new Date(facts.timestamp).getTime();
  if (age > REVOKE_WINDOW_MS) {
    throw new Error(
      `that message is ${Math.floor(age / 3_600_000)} hours old; WhatsApp only honours delete-for-everyone for about two days, and a late one is silently ignored by recipients`,
    );
  }
}

/**
 * Delete one of our own messages for everyone. In a group the key names this
 * account as participant, which is how Baileys keys a group message it sent
 * (Utils/messages.js generateWAMessageFromContent).
 */
export async function revokeMessageOnSocket(
  sock: ChatOpsSocket,
  store: Store,
  chatJid: string,
  messageId: string,
  meId: string | null,
  now: () => Date = () => new Date(),
): Promise<RevokeMessageResult> {
  const jid = normalizeJid(chatJid);
  checkRevocable(store, jid, messageId, now().getTime());
  const me = meId ? jidNormalizedUser(meId) : null;
  await sock.sendMessage(jid, {
    delete: {
      remoteJid: jid,
      fromMe: true,
      id: messageId,
      ...(jid.endsWith("@g.us") && me ? { participant: me } : {}),
    },
  });
  const revokedAt = now().toISOString();
  store.markRevoked(jid, messageId, revokedAt, me);
  return { ok: true, chatJid: jid, messageId, revokedAt };
}
