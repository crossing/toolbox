// The message store: a faithful mirror of the retired local Go bridge's SQLite
// schema (tools/whatsapp-bridge/main.go before 2026-09-16, a whatsmeow fork of
// lharries/whatsapp-mcp), so the same queries answer the same way and the
// one-off history import was a straight row copy.
//
// Deliberate differences from the Go schema, all additive:
//   - timestamps are ISO-8601 UTC ("2026-08-20T22:32:04.000Z") so that lexical
//     ordering is chronological and range filters are string comparisons. The
//     Go bridge writes time.Time in its own layout with a local offset
//     ("2026-08-20 23:32:04+01:00"), which sorts wrongly across offsets, so the
//     importer normalizes on the way in (scripts/wa-import.py);
//   - `sender_name` (WhatsApp's pushName) is kept because Baileys hands it to
//     us for free and group messages are unreadable without it;
//   - media descriptors are base64 TEXT rather than BLOB: DO SQLite handles
//     both, but the RPC boundary to the gateway is JSON, so base64 avoids a
//     conversion on every hop;
//   - lifecycle columns (2026-09-19): chats.archived / left_at / deleted_at and
//     messages.revoked_at / revoked_by / participant. They are added by
//     MIGRATIONS below rather than written into the CREATE TABLEs, so a fresh
//     store and the live one reach the same schema by the same path. Nothing
//     in this file ever deletes a row: leaving, archiving, deleting a chat and
//     revoking a message all set a flag and keep what was said.

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

// Additive only: a nullable column, or NOT NULL with a constant default, is the
// one kind of ALTER that SQLite applies without rewriting the table, so this is
// safe against the live Durable Object's storage and loses nothing. Each entry
// is applied at most once — the probe is a SELECT of the column, which fails to
// prepare when it is missing. (A PRAGMA would do, but this needs nothing from
// the platform beyond plain SQL, and runs unchanged under node:sqlite in tests.)
export const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "chats", column: "archived", ddl: "archived INTEGER NOT NULL DEFAULT 0" },
  { table: "chats", column: "left_at", ddl: "left_at TEXT" },
  { table: "chats", column: "deleted_at", ddl: "deleted_at TEXT" },
  { table: "messages", column: "revoked_at", ddl: "revoked_at TEXT" },
  { table: "messages", column: "revoked_by", ddl: "revoked_by TEXT" },
  // key.participant exactly as WhatsApp addressed it (a LID in newer groups).
  // `sender` holds the phone number instead, and an app-state message range
  // has to quote the key the phone knows the message by.
  { table: "messages", column: "participant", ddl: "participant TEXT" },
  // Why a message that arrived could not be read; null for every readable row.
  // A message WhatsApp delivered but the bridge could not decrypt is kept as a
  // visible placeholder instead of an anonymous empty row, and is overwritten
  // by the sender's resend when that arrives under the same id.
  { table: "messages", column: "decrypt_error", ddl: "decrypt_error TEXT" },
];

/** How long after a leave new activity has to be dated to count as a rejoin. */
const REJOIN_MARGIN_MS = 2 * 60 * 1000;

function hasColumn(sql: SqlLike, table: string, column: string): boolean {
  try {
    sql.exec(`SELECT ${column} FROM ${table} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

export function migrate(sql: SqlLike): void {
  for (const { table, column, ddl } of MIGRATIONS) {
    if (!hasColumn(sql, table, column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

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
  /** Raw key.participant of a group message someone else wrote. */
  participant?: string | null;
  /** Set on a placeholder for a message that arrived undecryptable. */
  decryptError?: string | null;
}

export interface StoredChat {
  jid: string;
  name?: string | null;
  lastMessageTime?: string | null;
  /** Only written when WhatsApp (or an archive call) actually said so. */
  archived?: boolean;
}

/** What an app-state message range needs to know about a chat's newest message. */
export interface LastMessageKey {
  id: string;
  fromMe: boolean;
  /** Who wrote it, for a group message from someone else; null otherwise. */
  participant: string | null;
  timestampSeconds: number;
}

const MESSAGE_COLUMNS = `m.id, m.chat_jid, m.sender, m.sender_name, m.content, m.timestamp,
  m.is_from_me, m.media_type, m.filename, m.revoked_at, m.decrypt_error, c.name AS chat_name`;

const CHAT_COLUMNS = "c.jid, c.name, c.last_message_time, c.archived, c.left_at, c.deleted_at";

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
    revoked: row.revoked_at != null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    undecryptable: row.decrypt_error != null,
    decryptError: (row.decrypt_error as string | null) ?? null,
  };
}

function toChatRow(row: Record<string, unknown>): ChatRow {
  return {
    jid: row.jid as string,
    name: (row.name as string | null) ?? null,
    lastMessageTime: (row.last_message_time as string | null) ?? null,
    archived: row.archived === 1,
    leftAt: (row.left_at as string | null) ?? null,
    deletedAt: (row.deleted_at as string | null) ?? null,
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

// Callers pass search text and phone numbers straight through to LIKE, where
// % and _ are wildcards. Bound parameters stop injection but not that, so the
// patterns are escaped and every LIKE declares the escape character.
const LIKE_ESCAPE = "\\";

function likePattern(value: string, shape: (escaped: string) => string): string {
  return shape(value.replace(/[\\%_]/g, (char) => `${LIKE_ESCAPE}${char}`));
}

/**
 * Tools advertise JIDs, and a model will hand one back where a phone number is
 * asked for. Accept both.
 */
export function phoneOrJidToPhone(value: string): string {
  return phoneOf(value.trim()).replace(/[^0-9]/g, "");
}

/** ISO-8601 in, ISO-8601 UTC out — the only form the store's ordering works on. */
export function toStoredTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`"${value}" is not a timestamp; use ISO-8601, e.g. 2026-08-20T22:32:04Z`);
  }
  return parsed.toISOString();
}

export class Store {
  constructor(private sql: SqlLike) {
    this.sql.exec(STORE_SCHEMA);
    migrate(this.sql);
  }

  upsertChat(chat: StoredChat): void {
    // A chat's name is only overwritten when we actually learn one: WhatsApp
    // sends bare JIDs constantly and a null would erase a known contact name.
    // deleted_at: WhatsApp re-creates a deleted chat the moment something new
    // is said in it, so activity dated after the delete lifts the flag.
    // left_at: a group that has been left goes silent, so anything said in it
    // well after the leave means this account was added back. "Well after",
    // because the leave's own system message is dated a moment after the flag.
    this.sql.exec(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = COALESCE(excluded.name, chats.name),
         last_message_time = CASE
           WHEN excluded.last_message_time IS NULL THEN chats.last_message_time
           WHEN chats.last_message_time IS NULL THEN excluded.last_message_time
           WHEN excluded.last_message_time > chats.last_message_time THEN excluded.last_message_time
           ELSE chats.last_message_time END,
         deleted_at = CASE
           WHEN chats.deleted_at IS NOT NULL AND excluded.last_message_time IS NOT NULL
             AND excluded.last_message_time > chats.deleted_at THEN NULL
           ELSE chats.deleted_at END,
         left_at = CASE
           WHEN chats.left_at IS NOT NULL AND excluded.last_message_time IS NOT NULL
             AND excluded.last_message_time > ? THEN NULL
           ELSE chats.left_at END`,
      normalizeJid(chat.jid),
      chat.name ?? null,
      chat.lastMessageTime ?? null,
      this.rejoinThreshold(chat.jid),
    );
    if (chat.archived !== undefined) this.setArchived(chat.jid, chat.archived);
  }

  // --- lifecycle flags --------------------------------------------------------
  //
  // Every one of these is an UPDATE of a flag. None removes a chat or a
  // message: the second brain's rule is that a record is never destroyed, only
  // annotated with what became of it.

  /** left_at plus a margin, as a comparable timestamp; "" sorts below everything when not left. */
  private rejoinThreshold(jid: string): string {
    const rows = this.sql.exec("SELECT left_at FROM chats WHERE jid = ?", normalizeJid(jid)).toArray();
    const leftAt = rows[0]?.left_at as string | null | undefined;
    if (!leftAt) return "";
    return new Date(new Date(leftAt).getTime() + REJOIN_MARGIN_MS).toISOString();
  }

  private ensureChat(jid: string): void {
    this.sql.exec("INSERT INTO chats (jid) VALUES (?) ON CONFLICT(jid) DO NOTHING", normalizeJid(jid));
  }

  setArchived(jid: string, archived: boolean): void {
    this.ensureChat(jid);
    this.sql.exec("UPDATE chats SET archived = ? WHERE jid = ?", archived ? 1 : 0, normalizeJid(jid));
  }

  /** `at` null means "a member again" — being re-added clears the flag. */
  setLeft(jid: string, at: string | null): void {
    this.ensureChat(jid);
    this.sql.exec("UPDATE chats SET left_at = ? WHERE jid = ?", at, normalizeJid(jid));
  }

  markChatDeleted(jid: string, at: string): void {
    this.ensureChat(jid);
    this.sql.exec("UPDATE chats SET deleted_at = ? WHERE jid = ?", at, normalizeJid(jid));
  }

  /**
   * Flag a message as deleted-for-everyone. Content is left exactly as it was.
   * Returns false when the store never held the message, so the caller can say
   * so rather than invent a row for something it never saw. The first revoke
   * wins: a replayed one does not move the timestamp.
   */
  markRevoked(chatJid: string, messageId: string, at: string, by: string | null): boolean {
    const chat = normalizeJid(chatJid);
    const found = this.sql
      .exec("SELECT 1 AS present FROM messages WHERE id = ? AND chat_jid = ?", messageId, chat)
      .toArray();
    if (found.length === 0) return false;
    this.sql.exec(
      `UPDATE messages SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?)
       WHERE id = ? AND chat_jid = ?`,
      at,
      by ? normalizeJid(by) : null,
      messageId,
      chat,
    );
    return true;
  }

  /**
   * File an inbound "delete for everyone". It lands on the row it withdraws.
   * When the store never held that row — sent and withdrawn while the bridge
   * was offline, in which case Baileys has already merged the two and the
   * content is gone (see normalize.ts) — a tombstone is filed under the
   * original id, so "someone deleted a message here" is on record even though
   * what it said never was. Returns whether the original was known.
   */
  recordRevoke(
    revoke: { chatJid: string; messageId: string; revokedBy: string | null; revokedAt: string },
    fromMe: boolean,
  ): boolean {
    if (this.markRevoked(revoke.chatJid, revoke.messageId, revoke.revokedAt, revoke.revokedBy)) return true;
    this.upsertMessage({
      id: revoke.messageId,
      chatJid: revoke.chatJid,
      sender: revoke.revokedBy ?? revoke.chatJid,
      content: null,
      timestamp: revoke.revokedAt,
      isFromMe: fromMe,
    });
    this.markRevoked(revoke.chatJid, revoke.messageId, revoke.revokedAt, revoke.revokedBy);
    return false;
  }

  /** The facts a revoke has to check before anything is sent. */
  messageFacts(chatJid: string, messageId: string): { isFromMe: boolean; timestamp: string; revokedAt: string | null } | null {
    const rows = this.sql
      .exec(
        "SELECT is_from_me, timestamp, revoked_at FROM messages WHERE id = ? AND chat_jid = ?",
        messageId,
        normalizeJid(chatJid),
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      isFromMe: row.is_from_me === 1,
      timestamp: row.timestamp as string,
      revokedAt: (row.revoked_at as string | null) ?? null,
    };
  }

  lastMessageKey(chatJid: string): LastMessageKey | null {
    const rows = this.sql
      .exec(
        `SELECT id, is_from_me, sender, participant, timestamp FROM messages
         WHERE chat_jid = ? ORDER BY timestamp DESC, id DESC LIMIT 1`,
        normalizeJid(chatJid),
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0]!;
    const fromMe = row.is_from_me === 1;
    const isGroup = normalizeJid(chatJid).endsWith("@g.us");
    return {
      id: row.id as string,
      fromMe,
      participant: isGroup && !fromMe ? ((row.participant as string | null) ?? (row.sender as string)) : null,
      timestampSeconds: Math.floor(new Date(row.timestamp as string).getTime() / 1000),
    };
  }

  /**
   * One of our own messages with its media descriptors, for answering a
   * recipient's retry request. Looked up by id among our own sends rather than
   * by (id, chat): the asking device may name a 1:1 chat by LID where the row
   * was filed under the phone number, and our ids are random enough to stand
   * alone. A match in the named chat is still preferred.
   */
  ownMessage(messageId: string, chatJid?: string | null): (StoredMessage & { revokedAt: string | null }) | null {
    const rows = this.sql
      .exec(
        `SELECT * FROM messages WHERE id = ? AND is_from_me = 1
         ORDER BY (chat_jid = ?) DESC LIMIT 1`,
        messageId,
        chatJid ? normalizeJid(chatJid) : "",
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      id: row.id as string,
      chatJid: row.chat_jid as string,
      sender: row.sender as string,
      content: (row.content as string | null) ?? null,
      timestamp: row.timestamp as string,
      isFromMe: true,
      mediaType: (row.media_type as string | null) ?? null,
      filename: (row.filename as string | null) ?? null,
      url: (row.url as string | null) ?? null,
      mediaKeyB64: (row.media_key as string | null) ?? null,
      fileSha256B64: (row.file_sha256 as string | null) ?? null,
      fileEncSha256B64: (row.file_enc_sha256 as string | null) ?? null,
      fileLength: (row.file_length as number | null) ?? null,
      directPath: (row.direct_path as string | null) ?? null,
      mimeType: (row.mime_type as string | null) ?? null,
      revokedAt: (row.revoked_at as string | null) ?? null,
    };
  }

  /** The best name the store has for a person: a chat name, else their latest pushName. */
  knownName(jid: string): string | null {
    const normalized = normalizeJid(jid);
    const chat = this.sql.exec("SELECT name FROM chats WHERE jid = ?", normalized).toArray();
    if (chat[0]?.name) return chat[0].name as string;
    const pushed = this.sql
      .exec(
        `SELECT sender_name FROM messages WHERE sender = ? AND is_from_me = 0 AND sender_name IS NOT NULL
         ORDER BY timestamp DESC LIMIT 1`,
        normalized,
      )
      .toArray();
    return (pushed[0]?.sender_name as string | undefined) ?? null;
  }

  countMessages(chatJid: string): number {
    const rows = this.sql
      .exec("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?", normalizeJid(chatJid))
      .toArray();
    return (rows[0]?.n as number) ?? 0;
  }

  upsertMessage(msg: StoredMessage): void {
    this.sql.exec(
      `INSERT INTO messages (
         id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
         media_type, filename, url, media_key, file_sha256, file_enc_sha256,
         file_length, direct_path, mime_type, participant, decrypt_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         mime_type = COALESCE(excluded.mime_type, messages.mime_type),
         participant = COALESCE(excluded.participant, messages.participant),
         decrypt_error = CASE
           WHEN excluded.decrypt_error IS NULL THEN NULL
           WHEN messages.decrypt_error IS NULL THEN NULL
           ELSE excluded.decrypt_error END`,
      msg.id,
      normalizeJid(msg.chatJid),
      normalizeJid(msg.sender),
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
      msg.participant ?? null,
      msg.decryptError ?? null,
    );
  }

  counts(): { chats: number; messages: number } {
    const chats = this.sql.exec("SELECT COUNT(*) AS n FROM chats").toArray()[0]?.n as number;
    const messages = this.sql.exec("SELECT COUNT(*) AS n FROM messages").toArray()[0]?.n as number;
    return { chats: chats ?? 0, messages: messages ?? 0 };
  }

  // --- reads, mirroring the retired local whatsapp-mcp-server ---------------

  searchContacts(query: string, limit = 50, page = 0): ContactRow[] {
    const like = likePattern(query, (escaped) => `%${escaped}%`);
    const capped = Math.min(Math.max(limit, 1), 200);
    return this.sql
      .exec(
        // One row per contact: pushName varies per message, so a plain
        // DISTINCT over (jid, name) would return the same person repeatedly.
        `SELECT jid, MAX(name) AS name FROM (
           SELECT c.jid AS jid, c.name AS name FROM chats c
             WHERE (c.name LIKE ? ESCAPE '${LIKE_ESCAPE}' OR c.jid LIKE ? ESCAPE '${LIKE_ESCAPE}')
               AND c.jid NOT LIKE '%@g.us'
           UNION ALL
           SELECT m.sender AS jid, m.sender_name AS name FROM messages m
             WHERE (m.sender_name LIKE ? ESCAPE '${LIKE_ESCAPE}' OR m.sender LIKE ? ESCAPE '${LIKE_ESCAPE}')
               AND m.is_from_me = 0
         ) GROUP BY jid ORDER BY name IS NULL, name, jid LIMIT ? OFFSET ?`,
        like,
        like,
        like,
        like,
        capped,
        page * capped,
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
      where = `WHERE (c.name LIKE ? ESCAPE '${LIKE_ESCAPE}' OR c.jid LIKE ? ESCAPE '${LIKE_ESCAPE}')`;
      const like = likePattern(q.query, (escaped) => `%${escaped}%`);
      bindings.push(like, like);
    }
    return this.sql
      .exec(
        `SELECT ${CHAT_COLUMNS} FROM chats c ${where}
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
      .exec(`SELECT ${CHAT_COLUMNS} FROM chats c WHERE c.jid = ?`, normalizeJid(chatJid))
      .toArray();
    return rows.length > 0 ? toChatRow(rows[0]!) : null;
  }

  getDirectChatByContact(phoneNumber: string): ChatRow | null {
    const digits = phoneOrJidToPhone(phoneNumber);
    if (!digits) return null;
    const rows = this.sql
      .exec(
        `SELECT ${CHAT_COLUMNS} FROM chats c
         WHERE c.jid LIKE ? ESCAPE '${LIKE_ESCAPE}' AND c.jid NOT LIKE '%@g.us'
         ORDER BY c.last_message_time IS NULL, c.last_message_time DESC LIMIT 1`,
        `${digits}@%`,
      )
      .toArray();
    return rows.length > 0 ? toChatRow(rows[0]!) : null;
  }

  getContactChats(jid: string, limit = 20, page = 0): ChatRow[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    return this.sql
      .exec(
        `SELECT DISTINCT ${CHAT_COLUMNS}
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
      const digits = phoneOrJidToPhone(q.senderPhoneNumber);
      clauses.push(`m.sender LIKE ? ESCAPE '${LIKE_ESCAPE}'`);
      bindings.push(`${digits}@%`);
    }
    if (q.query) {
      clauses.push(`m.content LIKE ? ESCAPE '${LIKE_ESCAPE}'`);
      bindings.push(likePattern(q.query, (escaped) => `%${escaped}%`));
    }
    // Stored timestamps are ISO-8601 UTC and compared lexically, so an
    // offset-bearing bound would silently include or exclude the wrong rows.
    if (q.after) {
      clauses.push("m.timestamp > ?");
      bindings.push(toStoredTimestamp(q.after));
    }
    if (q.before) {
      clauses.push("m.timestamp < ?");
      bindings.push(toStoredTimestamp(q.before));
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
         WHERE m.chat_jid = ? AND (m.timestamp < ? OR (m.timestamp = ? AND m.id < ?))
         ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
        message.chatJid,
        message.timestamp,
        message.timestamp,
        message.id,
        Math.min(Math.max(before, 0), 50),
      )
      .toArray()
      .map(toMessageRow)
      .reverse();
    const afterRows = this.sql
      .exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         WHERE m.chat_jid = ? AND (m.timestamp > ? OR (m.timestamp = ? AND m.id > ?))
         ORDER BY m.timestamp ASC, m.id ASC LIMIT ?`,
        message.chatJid,
        message.timestamp,
        message.timestamp,
        message.id,
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
