// The contract between the gateway worker and the WhatsApp bridge Durable
// Object, which lives in a *different* Worker script (so the bridge's
// lifetime, and its Baileys session, survive gateway deploys).
//
// Cross-script Durable Object stubs are not statically typed by wrangler, so
// the gateway casts its stub to `WhatsAppBridgeApi` and the bridge class is
// declared to implement it. Everything crossing the boundary must be
// structured-cloneable: plain JSON only, no Buffers, no class instances.

/** One row of the chats table, as tools see it. */
export interface ChatRow {
  jid: string;
  name: string | null;
  lastMessageTime: string | null;
}

/** One row of the messages table, as tools see it. */
export interface MessageRow {
  id: string;
  chatJid: string;
  chatName: string | null;
  sender: string;
  senderName: string | null;
  content: string | null;
  timestamp: string;
  isFromMe: boolean;
  mediaType: string | null;
  filename: string | null;
}

export interface BridgeStatus {
  paired: boolean;
  /** The paired device's own JID, once pairing completed. */
  me: { id: string; name: string | null } | null;
  /** Pending pairing code, if one was requested and has not expired. */
  pendingPairing: { phoneNumber: string; code: string; expiresAt: number } | null;
  connection: "idle" | "connecting" | "open" | "closing";
  lastConnectedAt: number | null;
  lastDrainAt: number | null;
  lastError: string | null;
  nextAlarmAt: number | null;
  chatCount: number;
  messageCount: number;
  /** Rolling log of the last few sync cycles, newest first. */
  recentCycles: BridgeCycle[];
  /** The bridge's own recent log lines, newest first. */
  log: string[];
}

export interface BridgeCycle {
  startedAt: number;
  endedAt: number | null;
  outcome: "ok" | "error" | "running";
  messages: number;
  chats: number;
  detail: string | null;
}

export interface SyncResult {
  ok: boolean;
  messages: number;
  chats: number;
  detail: string | null;
}

export interface PairingResult {
  code: string;
  phoneNumber: string;
  expiresAt: number;
}

export interface ListMessagesQuery {
  after?: string;
  before?: string;
  senderPhoneNumber?: string;
  chatJid?: string;
  query?: string;
  limit?: number;
  page?: number;
}

export interface ListChatsQuery {
  query?: string;
  limit?: number;
  page?: number;
  sortBy?: "last_active" | "name";
}

export interface ContactRow {
  jid: string;
  phoneNumber: string;
  name: string | null;
}

export interface MessageContext {
  message: MessageRow | null;
  before: MessageRow[];
  after: MessageRow[];
}

export interface LastInteraction {
  message: MessageRow | null;
}

export interface MediaResult {
  ok: boolean;
  /** Present when the media was small enough to inline. */
  base64?: string;
  /** Present when the media went to R2 instead. */
  key?: string;
  mimeType?: string;
  filename?: string | null;
  size?: number;
  detail?: string;
}

export interface ImportRequest {
  chats: { jid: string; name: string | null; lastMessageTime: string | null }[];
  messages: {
    id: string;
    chatJid: string;
    sender: string;
    content: string | null;
    timestamp: string;
    isFromMe: boolean;
    mediaType: string | null;
    filename: string | null;
    url: string | null;
    mediaKeyB64: string | null;
    fileSha256B64: string | null;
    fileEncSha256B64: string | null;
    fileLength: number | null;
  }[];
}

export interface ImportResult {
  chatsWritten: number;
  messagesWritten: number;
  skipped: number;
}

export interface ImportCode {
  code: string;
  expiresAt: number;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  detail?: string;
}

export interface PreflightResult {
  ok: boolean;
  steps: { name: string; ms: number; detail: string }[];
  detail: string | null;
}

export interface WhatsAppBridgeApi {
  status(): Promise<BridgeStatus>;
  /**
   * Exercise the expensive parts of a pairing — the 812-key pre-key burst and
   * the chunked key-store round trip — without touching WhatsApp. Refuses to
   * run against a paired session.
   */
  preflight(): Promise<PreflightResult>;
  requestPairingCode(phoneNumber: string): Promise<PairingResult>;
  unpair(): Promise<{ ok: boolean }>;
  syncNow(): Promise<SyncResult>;
  setAutoSync(enabled: boolean): Promise<{ enabled: boolean; nextAlarmAt: number | null }>;

  searchContacts(query: string, limit?: number, page?: number): Promise<ContactRow[]>;
  listMessages(query: ListMessagesQuery): Promise<MessageRow[]>;
  listChats(query: ListChatsQuery): Promise<ChatRow[]>;
  getChat(chatJid: string): Promise<ChatRow | null>;
  getDirectChatByContact(senderPhoneNumber: string): Promise<ChatRow | null>;
  getContactChats(jid: string, limit?: number, page?: number): Promise<ChatRow[]>;
  getLastInteraction(jid: string): Promise<LastInteraction>;
  getMessageContext(messageId: string, before?: number, after?: number): Promise<MessageContext>;
  downloadMedia(messageId: string, chatJid: string): Promise<MediaResult>;

  sendMessage(recipient: string, message: string): Promise<SendResult>;
  sendFile(
    recipient: string,
    filename: string,
    base64: string,
    mediaType?: string,
    caption?: string,
  ): Promise<SendResult>;

  /** Mint a short, human-typable code authorising history imports for a while. */
  issueImportCode(): Promise<ImportCode>;
  importRows(request: ImportRequest, code: string): Promise<ImportResult>;
}
