// The message store: a faithful mirror of the local Go bridge's SQLite schema
// (tools/whatsapp-bridge/main.go), so the same queries answer the same way and
// the one-off history import is a straight row copy.
//
// Deliberate differences from the Go schema, all additive:
//   - timestamps are stored as ISO-8601 strings, exactly as Go's sqlite driver
//     writes time.Time, so lexical ordering is chronological and the import
//     needs no conversion;
//   - `sender_name` (WhatsApp's pushName) is kept because Baileys hands it to
//     us for free and group messages are unreadable without it;
//   - media descriptors are base64 TEXT rather than BLOB: DO SQLite handles
//     both, but the RPC boundary to the gateway is JSON, so base64 avoids a
//     conversion on every hop.

import type { ChatRow, ContactRow, ListChatsQuery, ListMessagesQuery, MessageRow } from "@toolbox/mcp-shared";
import type { SqlLike } from "./auth";

export const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT NOT NULL,
  is_from_me INTEGER NOT NULL,
  media_type TEXT,
  filename TEXT,
  url TEXT,
  media_key TEXT,
  file_sha256 TEXT,
  file_enc_sha256 TEXT,
  file_length INTEGER,
  direct_path TEXT,
  mime_type TEXT,
  PRIMARY KEY (id, chat_jid)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages (timestamp);
`;

export interface StoredMessage {
  id: string;
  chatJid: string;
  sender: string;
  senderName?: string | null;
  content?: string | null;
  timestamp: string;
  isFromMe: boolean;
  mediaType?: string | null;
  filename?: string | null;
  url?: string | null;
  mediaKeyB64?: string | null;
  fileSha256B64?: string | null;
  fileEncSha256B64?: string | null;
  fileLength?: number | null;
  directPath?: string | null;
  mimeType?: string | null;
}

export interface StoredChat {
  jid: string;
  name?: string | null;
  lastMessageTime?: string | null;
}

const MESSAGE_COLUMNS = `m.id, m.chat_jid, m.sender, m.sender_name, m.content, m.timestamp,
  m.is_from_me, m.media_type, m.filename, c.name AS chat_name`;

function toMessageRow(row: Record<string, unknown>): MessageRow {
  return {
    id: row.id as string,
    chatJid: row.chat_jid as string,
    chatName: (row.chat_name as string | null) ?? null,
    sender: row.sender as string,
    senderName: (row.sender_name as string | null) ?? null,
    content: (row.content as string | null) ?? null,
    timestamp: row.timestamp as string,
    isFromMe: row.is_from_me === 1,
    mediaType: (row.media_type as string | null) ?? null,
    filename: (row.filename as string | null) ?? null,
  };
}

function toChatRow(row: Record<string, unknown>): ChatRow {
  return {
    jid: row.jid as string,
    name: (row.name as string | null) ?? null,
    lastMessageTime: (row.last_message_time as string | null) ?? null,
  };
}

// WhatsApp JIDs come in several shapes: 4479…@s.whatsapp.net for people,
// …@g.us for groups, …@lid for the privacy-preserving identifiers newer
// clients use, and occasionally with a :device suffix. Everything the store
// keys on is the bare user part, matching the Go bridge.
export function normalizeJid(jid: string): string {
  const [user = "", server = "s.whatsapp.net"] = jid.split("@");
  return `${user.split(":")[0]}@${server}`;
}

export function phoneOf(jid: string): string {
  return (jid.split("@")[0] ?? "").split(":")[0] ?? "";
}

export class Store {
  constructor(private sql: SqlLike) {
    this.sql.exec(STORE_SCHEMA);
  }

  upsertChat(chat: StoredChat): void {
    // A chat's name is only overwritten when we actually learn one: WhatsApp
    // sends bare JIDs constantly and a null would erase a known contact name.
    this.sql.exec(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = COALESCE(excluded.name, chats.name),
         last_message_time = CASE
           WHEN excluded.last_message_time IS NULL THEN chats.last_message_time
           WHEN chats.last_message_time IS NULL THEN excluded.last_message_time
           WHEN excluded.last_message_time > chats.last_message_time THEN excluded.last_message_time
           ELSE chats.last_message_time END`,
      normalizeJid(chat.jid),
      chat.name ?? null,
      chat.lastMessageTime ?? null,
    );
  }

  upsertMessage(msg: StoredMessage): void {
    this.sql.exec(
      `INSERT INTO messages (
         id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
         media_type, filename, url, media_key, file_sha256, file_enc_sha256,
         file_length, direct_path, mime_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, chat_jid) DO UPDATE SET
         content = COALESCE(excluded.content, messages.content),
         sender_name = COALESCE(excluded.sender_name, messages.sender_name),
         media_type = COALESCE(excluded.media_type, messages.media_type),
         filename = COALESCE(excluded.filename, messages.filename),
         url = COALESCE(excluded.url, messages.url),
         media_key = COALESCE(excluded.media_key, messages.media_key),
         file_sha256 = COALESCE(excluded.file_sha256, messages.file_sha256),
         file_enc_sha256 = COALESCE(excluded.file_enc_sha256, messages.file_enc_sha256),
         file_length = COALESCE(excluded.file_length, messages.file_length),
         direct_path = COALESCE(excluded.direct_path, messages.direct_path),
         mime_type = COALESCE(excluded.mime_type, messages.mime_type)`,
      msg.id,
      normalizeJid(msg.chatJid),
      msg.sender,
      msg.senderName ?? null,
      msg.content ?? null,
      msg.timestamp,
      msg.isFromMe ? 1 : 0,
      msg.mediaType ?? null,
      msg.filename ?? null,
      msg.url ?? null,
      msg.mediaKeyB64 ?? null,
      msg.fileSha256B64 ?? null,
      msg.fileEncSha256B64 ?? null,
      msg.fileLength ?? null,
      msg.directPath ?? null,
      msg.mimeType ?? null,
    );
  }

  counts(): { chats: number; messages: number } {
    const chats = this.sql.exec("SELECT COUNT(*) AS n FROM chats").toArray()[0]?.n as number;
    const messages = this.sql.exec("SELECT COUNT(*) AS n FROM messages").toArray()[0]?.n as number;
    return { chats: chats ?? 0, messages: messages ?? 0 };
  }

  // --- reads, mirroring tools/whatsapp-mcp-server ---------------------------

  searchContacts(query: string): ContactRow[] {
    const like = `%${query}%`;
    return this.sql
      .exec(
        `SELECT DISTINCT jid, name FROM (
           SELECT c.jid AS jid, c.name AS name FROM chats c
             WHERE (c.name LIKE ? OR c.jid LIKE ?) AND c.jid NOT LIKE '%@g.us'
           UNION
           SELECT m.sender AS jid, m.sender_name AS name FROM messages m
             WHERE (m.sender_name LIKE ? OR m.sender LIKE ?) AND m.is_from_me = 0
         ) ORDER BY name IS NULL, name, jid`,
        like,
        like,
        like,
        like,
      )
      .toArray()
      .map((row) => ({
        jid: row.jid as string,
        phoneNumber: phoneOf(row.jid as string),
        name: (row.name as string | null) ?? null,
      }));
  }

  listChats(q: ListChatsQuery): ChatRow[] {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 200);
    const offset = (q.page ?? 0) * limit;
    const order = q.sortBy === "name" ? "c.name IS NULL, c.name" : "c.last_message_time IS NULL, c.last_message_time DESC";
    const bindings: unknown[] = [];
    let where = "";
    if (q.query) {
      where = "WHERE (c.name LIKE ? OR c.jid LIKE ?)";
      bindings.push(`%${q.query}%`, `%${q.query}%`);
    }
    return this.sql
      .exec(
        `SELECT c.jid, c.name, c.last_message_time FROM chats c ${where}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...bindings,
        limit,
        offset,
      )
      .toArray()
      .map(toChatRow);
  }

  getChat(chatJid: string): ChatRow | null {
    const rows = this.sql
      .exec("SELECT jid, name, last_message_time FROM chats WHERE jid = ?", normalizeJid(chatJid))
      .toArray();
    return rows.length > 0 ? toChatRow(rows[0]!) : null;
  }

  getDirectChatByContact(phoneNumber: string): ChatRow | null {
    const rows = this.sql
      .exec(
        `SELECT jid, name, last_message_time FROM chats
         WHERE jid LIKE ? AND jid NOT LIKE '%@g.us'
         ORDER BY last_message_time IS NULL, last_message_time DESC LIMIT 1`,
        `${phoneNumber}@%`,
      )
      .toArray();
    return rows.length > 0 ? toChatRow(rows[0]!) : null;
  }

  getContactChats(jid: string, limit = 20, page = 0): ChatRow[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    return this.sql
      .exec(
        `SELECT DISTINCT c.jid, c.name, c.last_message_time
         FROM chats c JOIN messages m ON m.chat_jid = c.jid
         WHERE c.jid = ? OR m.sender = ?
         ORDER BY c.last_message_time IS NULL, c.last_message_time DESC
         LIMIT ? OFFSET ?`,
        normalizeJid(jid),
        normalizeJid(jid),
        capped,
        page * capped,
      )
      .toArray()
      .map(toChatRow);
  }

  getLastInteraction(jid: string): MessageRow | null {
    const normalized = normalizeJid(jid);
    const rows = this.sql
      .exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         WHERE m.chat_jid = ? OR m.sender = ?
         ORDER BY m.timestamp DESC LIMIT 1`,
        normalized,
        normalized,
      )
      .toArray();
    return rows.length > 0 ? toMessageRow(rows[0]!) : null;
  }

  listMessages(q: ListMessagesQuery): MessageRow[] {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 200);
    const offset = (q.page ?? 0) * limit;
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (q.chatJid) {
      clauses.push("m.chat_jid = ?");
      bindings.push(normalizeJid(q.chatJid));
    }
    if (q.senderPhoneNumber) {
      clauses.push("m.sender LIKE ?");
      bindings.push(`${q.senderPhoneNumber}@%`);
    }
    if (q.query) {
      clauses.push("m.content LIKE ?");
      bindings.push(`%${q.query}%`);
    }
    if (q.after) {
      clauses.push("m.timestamp > ?");
      bindings.push(q.after);
    }
    if (q.before) {
      clauses.push("m.timestamp < ?");
      bindings.push(q.before);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.sql
      .exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         ${where} ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`,
        ...bindings,
        limit,
        offset,
      )
      .toArray()
      .map(toMessageRow);
  }

  getMessageContext(messageId: string, before = 5, after = 5) {
    const target = this.sql
      .exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid WHERE m.id = ? LIMIT 1`,
        messageId,
      )
      .toArray();
    if (target.length === 0) return { message: null, before: [], after: [] };
    const message = toMessageRow(target[0]!);
    const beforeRows = this.sql
      .exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         WHERE m.chat_jid = ? AND m.timestamp < ?
         ORDER BY m.timestamp DESC LIMIT ?`,
        message.chatJid,
        message.timestamp,
        Math.min(Math.max(before, 0), 50),
      )
      .toArray()
      .map(toMessageRow)
      .reverse();
    const afterRows = this.sql
      .exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         WHERE m.chat_jid = ? AND m.timestamp > ?
         ORDER BY m.timestamp ASC LIMIT ?`,
        message.chatJid,
        message.timestamp,
        Math.min(Math.max(after, 0), 50),
      )
      .toArray()
      .map(toMessageRow);
    return { message, before: beforeRows, after: afterRows };
  }

  /** Media descriptors for a stored message, for the download path. */
  mediaFor(messageId: string, chatJid: string): {
    mediaType: string | null;
    url: string | null;
    directPath: string | null;
    mediaKeyB64: string | null;
    fileSha256B64: string | null;
    fileEncSha256B64: string | null;
    fileLength: number | null;
    filename: string | null;
    mimeType: string | null;
  } | null {
    const rows = this.sql
      .exec(
        `SELECT media_type, url, direct_path, media_key, file_sha256, file_enc_sha256,
                file_length, filename, mime_type
         FROM messages WHERE id = ? AND chat_jid = ?`,
        messageId,
        normalizeJid(chatJid),
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      mediaType: (row.media_type as string | null) ?? null,
      url: (row.url as string | null) ?? null,
      directPath: (row.direct_path as string | null) ?? null,
      mediaKeyB64: (row.media_key as string | null) ?? null,
      fileSha256B64: (row.file_sha256 as string | null) ?? null,
      fileEncSha256B64: (row.file_enc_sha256 as string | null) ?? null,
      fileLength: (row.file_length as number | null) ?? null,
      filename: (row.filename as string | null) ?? null,
      mimeType: (row.mime_type as string | null) ?? null,
    };
  }
}
