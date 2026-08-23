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
  /**
   * A live linking QR, described but not quoted. The string itself only comes
   * back from `pairingQr()`, so the page that draws it asks for it and nothing
   * else — including the MCP status tool — ever carries it.
   */
  pendingQr: { issuedAt: number; expiresAt: number } | null;
  /** What WhatsApp → Linked devices will call this bridge. */
  deviceName: string;
  connection: "idle" | "connecting" | "open" | "closing";
  autoSync: boolean;
  verbose: boolean;
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
  /**
   * Open a socket and hold it while WhatsApp issues linking QRs. Preferred
   * over the phone-code path: it is the flow WhatsApp itself treats as
   * ordinary, and it is the only one where a client may name itself.
   */
  beginQrPairing(): Promise<{ expiresAt: number }>;
  /** The live QR string, for whoever is drawing it. Null once it has expired. */
  pairingQr(): Promise<{ qr: string; expiresAt: number } | null>;
  /** Drop an attempt nobody completed, instead of waiting out the window. */
  cancelPairing(): Promise<{ ok: boolean }>;
  /** The name a QR pairing registers; takes effect at the next pairing. */
  setDeviceName(name: string): Promise<{ deviceName: string }>;
  requestPairingCode(phoneNumber: string): Promise<PairingResult>;
  unpair(): Promise<{ ok: boolean }>;
  syncNow(): Promise<SyncResult>;
  setAutoSync(enabled: boolean): Promise<{ enabled: boolean; nextAlarmAt: number | null }>;
  /** Forward Baileys' own logs and every inbound stanza into the bridge log. */
  setVerbose(enabled: boolean): Promise<{ verbose: boolean }>;
  /** Advertise the freshly-fetched web version instead of Baileys' pinned one. */
  setUseLatestVersion(enabled: boolean): Promise<{ useLatestVersion: boolean }>;

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
