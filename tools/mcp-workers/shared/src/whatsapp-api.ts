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
  /**
   * Lifecycle flags. A chat that was archived, left or deleted on WhatsApp is
   * still listed — flagged, never hidden — because the bridge keeps its
   * messages whatever happens to the chat on the phone.
   */
  archived: boolean;
  /** When this account left the group (ISO-8601 UTC); null while a member. */
  leftAt: string | null;
  /** When the chat was deleted on WhatsApp; the stored messages remain. */
  deletedAt: string | null;
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
  /**
   * True when the message was deleted for everyone — by its sender, a group
   * admin, or this bridge. The row and its content are kept: the flag records
   * that it was withdrawn, not that it never existed.
   */
  revoked: boolean;
  revokedAt: string | null;
  /**
   * True for a placeholder: WhatsApp delivered a message here that the bridge
   * could not decrypt. A resend was requested from the sender; if it arrives it
   * replaces this row under the same id. `decryptError` is the reason given.
   */
  undecryptable: boolean;
  decryptError: string | null;
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
  /**
   * Whether this device holds an app-state sync key from the phone. Archiving
   * and deleting chats are app-state patches and cannot be sent without one;
   * null means it does, otherwise this says what is missing.
   */
  appStateProblem: string | null;
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

/**
 * Outgoing files: the bridge refuses anything larger, whether the bytes came
 * inline over MCP or were fetched server-side from Drive. One constant so the
 * gateway can refuse *before* downloading rather than after.
 */
export const WHATSAPP_SEND_BYTE_CAP = 5 * 1024 * 1024;

export interface SendResult {
  ok: boolean;
  messageId?: string;
  detail?: string;
}

/**
 * What became of one requested member. Creating a group is not all-or-nothing:
 * WhatsApp builds the group and then answers per participant, so a member whose
 * privacy settings forbid being added by a non-contact is reported here rather
 * than failing the call.
 */
export interface GroupParticipantResult {
  /** The participant exactly as the caller gave it. */
  requested: string;
  /** The JID that was sent to WhatsApp for it. */
  jid: string;
  /**
   * `added` — in the group. `invite_required` — WhatsApp refused the direct add
   * (403) and the person has to join by invite. `failed` — any other refusal;
   * `code` says which. `unknown` — the reply did not mention this participant.
   * `removed` / `promoted` / `demoted` are the successes of the other
   * whatsapp_group_update_participants actions.
   */
  status: "added" | "removed" | "promoted" | "demoted" | "invite_required" | "failed" | "unknown";
  /** WhatsApp's per-participant status code; 200 on success, null when unknown. */
  code: number | null;
  detail?: string;
}

export interface CreateGroupResult {
  ok: boolean;
  /** The new group's JID (…@g.us); usable as a recipient straight away. */
  groupJid?: string;
  subject?: string;
  participants?: GroupParticipantResult[];
  /**
   * https://chat.whatsapp.com/… — fetched only when someone could not be added
   * directly, so it can be sent to them by hand. Null when nobody needed it.
   */
  inviteLink?: string | null;
  /** Set when the group exists but something after creation went wrong. */
  detail?: string;
}

export interface LeaveGroupResult {
  ok: boolean;
  groupJid?: string;
  /** ISO-8601 UTC, as recorded on the chat row. */
  leftAt?: string;
  detail?: string;
}

export interface ArchiveChatResult {
  ok: boolean;
  chatJid?: string;
  archived?: boolean;
  /** True when the store held no message for the chat and an empty range was sent. */
  emptyChat?: boolean;
  detail?: string;
}

export interface DeleteChatResult {
  ok: boolean;
  chatJid?: string;
  /** True when this call left the group before deleting it (or tried to). */
  left?: boolean;
  deletedAt?: string;
  /** How many of the chat's messages the bridge still holds — never reduced by a delete. */
  messagesKept?: number;
  detail?: string;
}

export interface RevokeMessageResult {
  ok: boolean;
  chatJid?: string;
  messageId?: string;
  revokedAt?: string;
  detail?: string;
}

export interface GroupMember {
  /** The member as the group addresses them: a LID in newer groups, else a number JID. */
  jid: string;
  /** Their phone-number JID, when WhatsApp supplied one. */
  phoneNumber: string | null;
  lid: string | null;
  admin: "admin" | "superadmin" | null;
  isMe: boolean;
  /** What the store already calls them — a chat name or their latest pushName. */
  name: string | null;
}

export interface GroupInfoResult {
  ok: boolean;
  groupJid?: string;
  subject?: string | null;
  description?: string | null;
  owner?: string | null;
  /** ISO-8601 UTC; null when WhatsApp did not say. */
  createdAt?: string | null;
  size?: number;
  addressingMode?: "lid" | "pn";
  /** Only admins may send. */
  announce?: boolean;
  /** Only admins may edit the group's info. */
  restrict?: boolean;
  participants?: GroupMember[];
  /** The admins' JIDs, as phone numbers where known. */
  admins?: string[];
  iAmAdmin?: boolean;
  /** Fetched only when this account is an admin; null otherwise. */
  inviteLink?: string | null;
  detail?: string;
}

export type GroupParticipantAction = "add" | "remove" | "promote" | "demote";

export interface UpdateParticipantsResult {
  ok: boolean;
  groupJid?: string;
  action?: GroupParticipantAction;
  participants?: GroupParticipantResult[];
  /** As in CreateGroupResult: only fetched when an add was refused. */
  inviteLink?: string | null;
  detail?: string;
}

export interface GroupSubjectResult {
  ok: boolean;
  groupJid?: string;
  subject?: string;
  detail?: string;
}

export interface GroupInviteResult {
  ok: boolean;
  groupJid?: string;
  /** The new link; every earlier link to the group stops working. */
  inviteLink?: string;
  detail?: string;
}

/**
 * What WhatsApp will show about a person right now. Fetched live and not
 * stored. Every field is independent: one the other person's privacy settings
 * withhold comes back null, and one that failed is named in `errors`.
 */
export interface ProfileResult {
  ok: boolean;
  requested?: string;
  /** The JID the lookups were made with. */
  jid?: string;
  phoneNumber?: string | null;
  lid?: string | null;
  /** Registered on WhatsApp? null when it could not be checked (a LID cannot be). */
  exists?: boolean | null;
  /** From the bridge's own store, not from WhatsApp. */
  name?: string | null;
  about?: { text: string; setAt: string | null } | null;
  /** URLs only — short-lived, and nothing is downloaded. `hidden` when privacy settings refused. */
  picture?: { preview: string | null; full: string | null; hidden?: boolean };
  isBusiness?: boolean;
  business?: {
    description: string | null;
    category: string | null;
    website: string[];
    email: string | null;
    address: string | null;
    hours: {
      timezone: string | null;
      /** Minutes after midnight, as WhatsApp gives them. */
      days: { day: string | null; mode: string | null; openMinute: number | null; closeMinute: number | null }[];
    } | null;
  } | null;
  errors?: Record<string, string>;
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

  /**
   * Create a WhatsApp group with this account as its admin. `participants` are
   * phone numbers in international format or user JIDs. The group is filed in
   * the chat store, so it lists and accepts sends immediately.
   */
  createGroup(subject: string, participants: string[]): Promise<CreateGroupResult>;

  /** Leave a group. The chat row is flagged as left; nothing stored is removed. */
  leaveGroup(groupJid: string): Promise<LeaveGroupResult>;
  /**
   * Archive or unarchive a chat on WhatsApp (an app-state patch, so it syncs
   * to the phone). Fails with `appStateProblem`'s text when the device holds
   * no app-state sync key.
   */
  archiveChat(chatJid: string, archive: boolean): Promise<ArchiveChatResult>;
  /**
   * Delete the chat on WhatsApp. The bridge's own copy of its messages is
   * kept and the chat row flagged deleted. A group must have been left first,
   * unless `leaveFirst` asks for both.
   */
  deleteChat(chatJid: string, leaveFirst?: boolean): Promise<DeleteChatResult>;
  /** Delete one of this account's own messages for everyone. The row is kept, flagged. */
  revokeMessage(chatJid: string, messageId: string): Promise<RevokeMessageResult>;

  groupInfo(groupJid: string): Promise<GroupInfoResult>;
  /** A live, unstored look at one person's WhatsApp profile. */
  getProfile(jidOrPhone: string): Promise<ProfileResult>;
  groupUpdateParticipants(
    groupJid: string,
    participants: string[],
    action: GroupParticipantAction,
  ): Promise<UpdateParticipantsResult>;
  groupUpdateSubject(groupJid: string, subject: string): Promise<GroupSubjectResult>;
  /** Invalidate the group's invite link and return the replacement. */
  groupRevokeInvite(groupJid: string): Promise<GroupInviteResult>;

  /** Mint a short, human-typable code authorising history imports for a while. */
  issueImportCode(): Promise<ImportCode>;
  importRows(request: ImportRequest, code: string): Promise<ImportResult>;
}
