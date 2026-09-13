/**
 * Thunderbird-specific WebExtension API type declarations.
 *
 * `@types/firefox-webext-browser` covers the shared (Gecko) surface but not the
 * Thunderbird-only APIs (spaces, mailTabs, messageDisplay, compose, messages,
 * folders, accounts, ...). These augment the global `browser` namespace with
 * the shapes the add-on uses, derived from the installed Thunderbird's WebExtension
 * schema files (chrome/messenger/content/messenger/schemas/*.json).
 *
 * Only the namespaces actually used are declared; add more as T2/T3 land.
 */

/** browser.spaces — manage custom spaces + the spaces toolbar (spaces.json). */
declare namespace browser.spaces {
  /** Properties for the tab opened when the space's toolbar button is clicked. */
  interface SpaceTabProperties {
    /** Default URL; may point to a WebExtension page or a web page. */
    url?: string;
    /** CookieStore id used by the tab. */
    cookieStoreId?: string;
    /** How hyperlinks are handled (default "balanced"). */
    linkHandler?: "strict" | "balanced" | "relaxed";
  }

  /** Properties of the space's button in the spaces toolbar (MV3 subset). */
  interface SpaceButtonProperties {
    /** Path(s) to the button icon; reset to the extension icon when empty. */
    defaultIcon?: string | Record<string, string>;
    /** Dark/light icon sets for themes. */
    themeIcons?: Array<Record<string, string>>;
    /** Tooltitle for the button. */
    title?: string;
    /** Badge text (short). */
    badgeText?: string;
  }

  /** A space (built-in or extension-owned). */
  interface Space {
    /** Unique integer id (>= 1). */
    id: number;
    /** Space name (alphanumeric + underscore; unique per extension). */
    name: string;
    /** True for Thunderbird's default spaces. */
    isBuiltIn: boolean;
    /** True when this extension created the space. */
    isSelfOwned: boolean;
    /** Owning extension id (requires `management` to be populated). */
    extensionId?: string;
  }

  /** Filter for spaces.query(). */
  interface QueryInfo {
    spaceId?: number;
    name?: string;
    isBuiltIn?: boolean;
    isSelfOwned?: boolean;
    extensionId?: string;
  }

  /**
   * Create a custom space and add its button to the spaces toolbar.
   * `tabProperties` may be a URL string or a SpaceTabProperties object.
   * Throws if a space with this name already exists for the extension.
   */
  function create(
    name: string,
    tabProperties?: string | SpaceTabProperties,
    buttonProperties?: SpaceButtonProperties,
  ): Promise<Space>;

  /** Open (or switch to) a space; resolves the opened/activated tab. */
  function open(spaceId: number, windowId?: number): Promise<browser.tabs.Tab>;

  /** Retrieve a space by id. */
  function get(spaceId: number): Promise<Space>;

  /** List spaces matching the query (all when omitted). */
  function query(queryInfo?: QueryInfo): Promise<Space[]>;

  /** Update a space's tab/button properties. */
  function update(
    spaceId: number,
    tabProperties?: string | SpaceTabProperties | SpaceButtonProperties,
    buttonProperties?: SpaceButtonProperties,
  ): Promise<void>;

  /** Remove an extension-owned space. */
  function remove(spaceId: number): Promise<void>;
}

/** Shared mail shapes (used across messages/mailTabs/messageDisplay). */
declare namespace browser.mailTypes {
  /** RFC 5322 mailbox string, e.g. "Name <addr@example>". */
  type MailboxString = string;

  /** A date: RFC 3339 string (WebExtension `Date`). May be a number (epoch ms). */
  type Date = string | number;

  /** Basic information about a message (the `messages.MessageHeader`). */
  interface MessageHeader {
    /** Transient numeric id — valid only in the current session. */
    id: number;
    /** Durable Message-ID header. */
    headerMessageId?: string;
    subject?: string;
    author?: MailboxString;
    recipients?: MailboxString[];
    ccList?: MailboxString[];
    bccList?: MailboxString[];
    date?: Date;
    read?: boolean;
    flagged?: boolean;
    new?: boolean;
    size?: number;
    tags?: string[];
    priority?: string;
    junk?: boolean;
    junkScore?: number;
    headersOnly?: boolean;
    external?: boolean;
    folder?: browser.folders.MailFolder;
  }

  /** A (possibly paginated) list of messages. */
  interface MessageList {
    /** Id to pass to messages.continueList / abortList, or null. */
    id: string | null;
    messages: MessageHeader[];
  }

  /** A MIME part (the whole message when at the root). */
  interface MessagePart {
    contentType?: string;
    partName?: string;
    name?: string;
    /** Decoded text content; present for text/* parts when decodeContent. */
    body?: string;
    parts?: MessagePart[];
    decryptionStatus?: string;
    size?: number;
  }

  /** An attachment in a message. */
  interface MessageAttachment {
    partName: string;
    name: string;
    contentType: string;
    size: number;
    contentDisposition?: string;
    type?: "attachment" | "inline" | "cloudFile";
    linkUrl?: string;
  }
}

/** browser.mailTabs — the mail tabs (message + folder panes). */
declare namespace browser.mailTabs {
  interface MailTab {
    /**
     * The mail-tab id. In MV3 (this add-on) `convertMailTab` exposes this as
     * `tabId` (== the browser tab id); in MV2 it was `id`. This is what the
     * other mail APIs' `tabId` parameter refers to.
     */
    tabId: number;
    windowId?: number;
    active?: boolean;
    displayedFolder?: browser.folders.MailFolder;
  }
  interface QueryInfo {
    /** Whether the tabs are active in their windows. */
    active?: boolean;
    /** Whether the tabs are in the current window. */
    currentWindow?: boolean;
    /** Whether the tabs are in the last focused window. */
    lastFocusedWindow?: boolean;
    /** The parent window id (-2 = last focused, -1 = current, or a specific id). */
    windowId?: number;
  }
  /** The currently focused mail tab (throws if there is none). */
  function getCurrent(): Promise<MailTab>;
  function get(tabId: number): Promise<MailTab>;
  function query(queryInfo?: QueryInfo): Promise<MailTab[]>;
  /** The folder(s) currently selected in a mail tab's folder pane. */
  function getSelectedFolders(tabId?: number): Promise<browser.folders.MailFolder[]>;
  /** The message(s) the user selected in a mail tab (paginated list). */
  function getSelectedMessages(tabId?: number): Promise<browser.mailTypes.MessageList>;
  /** The messages listed in a mail tab's message pane (paginated list). */
  function getListedMessages(tabId?: number, options?: Record<string, unknown>): Promise<browser.mailTypes.MessageList>;
}

/** browser.messageDisplay — the message currently shown in the message pane. */
declare namespace browser.messageDisplay {
  /** The single message displayed (throws if none). */
  function getDisplayedMessage(tabId?: number): Promise<browser.mailTypes.MessageHeader>;
  /** The messages displayed in the pane (paginated list). */
  function getDisplayedMessages(tabId?: number): Promise<browser.mailTypes.MessageList>;
}

/** browser.messages — read access to individual messages (messagesRead). */
declare namespace browser.messages {
  /** Normalized metadata for one message (no body). */
  function get(messageId: number): Promise<browser.mailTypes.MessageHeader>;
  /** The decoded MIME part tree for one message (bodies for text/* parts). */
  function getFull(
    messageId: number,
    options?: { decrypt?: boolean; decodeHeaders?: boolean; decodeContent?: boolean },
  ): Promise<browser.mailTypes.MessagePart>;
  /** The attachments of one message (metadata only). */
  function listAttachments(messageId: number): Promise<browser.mailTypes.MessageAttachment[]>;
  /** The file for one attachment (a DOM File/Blob). */
  function getAttachmentFile(messageId: number, partName: string): Promise<File>;
  /** Search messages (paginated list). */
  function query(queryInfo?: Record<string, unknown>): Promise<browser.mailTypes.MessageList>;
  /** Continue a paginated message list (from a list id). */
  function continueList(messageListId: string): Promise<browser.mailTypes.MessageList>;
  /** Abort a paginated message list. */
  function abortList(messageListId: string): Promise<void>;
  /** Mutable properties that can be set via update() (T4). */
  interface MessageProperties {
    read?: boolean;
    flagged?: boolean;
    /** Tag names to set on the message. */
    tags?: string[];
    [key: string]: unknown;
  }
  /** Update mutable properties of one message (messagesUpdate). */
  function update(messageId: number, newProperties: MessageProperties): Promise<void>;
  /** Move messages to a folder by id (messagesMove). */
  function move(messageIds: number[], folderId: string, options?: Record<string, unknown>): Promise<void>;
  /** Archive messages to the account's Archive folder (messagesMove). Reversible. */
  function archive(messageIds: number[]): Promise<void>;
}

/** browser.messages.tags — tag management (messagesTags permission). */
declare namespace browser.messages.tags {
  interface TagInfo {
    /** Internal tag key (lowercase) — used in query filters and update(). */
    key: string;
    /** Human-readable tag name. */
    tag: string;
    /** 6-hex color (uppercased). */
    color?: string;
    ordinal?: number;
  }
  /** All tags (key + name + color). */
  function list(): Promise<TagInfo[]>;
  /** One tag by key. */
  function get(key: string): Promise<TagInfo>;
  /** Create a tag; returns the associated key. The key must be a string (not null).
   *  A 6-hex color (e.g. "#888888") should be supplied. */
  function create(key: string, tag: string, color?: string): Promise<string>;
}

/** browser.contacts — address book (T6, addressBooks permission). Read-only here (no create/update/delete). */
/** browser.addressBooks.contacts — the MV3 contacts API.
 *  NOTE: the top-level `browser.contacts` namespace is MV2-only (max_manifest_version: 2)
 *  and is NOT registered in an MV3 add-on, so it is `undefined` at runtime. The MV3 path
 *  is `browser.addressBooks.contacts.*` (min_manifest_version: 3, $import: contacts). */
declare namespace browser.addressBooks {
  interface AddressBook {
    /** The address book's id (pass to contacts.list). */
    id: string;
    name?: string;
    readOnly?: boolean;
    remote?: boolean;
    [key: string]: unknown;
  }
  /** List all address books (id, name, readOnly, remote). */
  function list(): Promise<AddressBook[]>;
  namespace contacts {
    interface Contact {
      /** The durable contact id (cardKey). */
      id: string;
      cardKey?: string;
      /** vCard-style flat properties (firstName, lastName, displayName, email/emailAddresses, organization, tel, ...). */
      properties?: Record<string, unknown>;
      vCard?: string;
    }
    interface QueryInfo {
      searchString?: string;
      /** Include local address books (default false — REQUIRED to search the Personal book). */
      includeLocal?: boolean;
      includeRemote?: boolean;
      includeReadOnly?: boolean;
      includeReadWrite?: boolean;
      [key: string]: unknown;
    }
    /** All contacts in one address book (by id). */
    function list(parentId?: string): Promise<Contact[]>;
    /** Search contacts across the address books. */
    function query(queryInfo: QueryInfo): Promise<Contact[]>;
    /** Get one contact by its id (cardKey). */
    function get(contactId: string): Promise<Contact>;
  }
}

/** browser.folders — mail folders (accountsRead). */
declare namespace browser.folders {
  interface MailFolder {
    id?: string;
    name?: string;
    path?: string;
    accountId?: string;
    isRoot?: boolean;
    isUnified?: boolean;
    isVirtual?: boolean;
    isTag?: boolean;
    isFavorite?: boolean;
    subFolders?: MailFolder[];
  }
  function query(queryInfo?: { accountId?: string; [k: string]: unknown }): Promise<MailFolder[]>;
  function get(folderId: string, includeSubFolders?: boolean): Promise<MailFolder>;
}

/** browser.accounts — mail accounts + identities (accountsRead). */
declare namespace browser.accounts {
  interface MailIdentity {
    id: string;
    name?: string;
    email?: string;
    label?: string;
    organization?: string;
  }
  interface MailAccount {
    id: string;
    name: string;
    type?: string;
    rootFolder?: browser.folders.MailFolder;
    identities?: MailIdentity[];
    folders?: browser.folders.MailFolder[] | null;
  }
  function list(includeSubFolders?: boolean): Promise<MailAccount[]>;
  function get(accountId: string, includeSubFolders?: boolean): Promise<MailAccount | null>;
  function getDefault(includeSubFolders?: boolean): Promise<MailAccount | null>;
}

/**
 * browser.piPane — a custom Experiment API (manifest `experiment_apis`) that
 * injects the Pi side panel as a native 4th column in about:3pane. Privileged
 * (addon_parent); available to the background only. See experiments/piPane/.
 */
declare namespace browser.piPane {
  interface PaneState {
    /** True when the pane is installed in the tab's about:3pane. */
    open: boolean;
    /** Current width in px (defined when open). */
    width?: number;
    /** The tab this state was read for. */
    tabId: number;
  }
  /** Install the pane into the given mail 3-pane tab (rejects if not one). */
  function open(tabId: number): Promise<void>;
  /** Remove the pane from the given mail 3-pane tab. */
  function close(tabId: number): Promise<void>;
  /** Toggle the pane; resolves the resulting state. */
  function toggle(tabId: number): Promise<PaneState>;
  /** Set the pane width in px. */
  function setWidth(tabId: number, width: number): Promise<void>;
  /** Read the pane's open/width state. */
  function getState(tabId: number): Promise<PaneState>;
}

/**
 * browser.compose — draft-first compose (compose permission). The prepare* functions
 * open a populated compose window (returned as a tab); get/setComposeDetails read/edit
 * an open window. `sendMessage`/`saveMessage` are deliberately NOT declared: the add-on
 * never sends — the user reviews the window and presses Send.
 */
declare namespace browser.compose {
  interface ComposeRecipient {
    name?: string;
    email?: string;
  }
  /** A recipient as a mailbox string ("Name <a@x>" / "a@x") or a {name,email} object. */
  type Recipient = string | ComposeRecipient;
  type RecipientList = Recipient | Recipient[];
  interface ComposeDetails {
    to?: RecipientList;
    cc?: RecipientList;
    bcc?: RecipientList;
    subject?: string;
    /** The HTML (or plain) body. */
    body?: string;
    contentType?: string;
  }
  /** The read subset returned by getComposeDetails. */
  interface ComposeDetailsResult extends ComposeDetails {
    /** new | reply | forward | draft | redirect. */
    type?: string;
    /** The numeric id of the message being replied/forwarded, if any. */
    relatedMessageId?: number | null;
  }
  /** The compose window tab (its `id` is what the other compose functions take). */
  interface ComposeTab {
    id: number;
    [key: string]: unknown;
  }
  function beginNew(messageId: number | null, details?: ComposeDetails): Promise<ComposeTab>;
  function beginReply(
    messageId: number,
    replyType?: "replyToSender" | "replyToList" | "replyToAll",
    details?: ComposeDetails,
  ): Promise<ComposeTab>;
  function beginForward(
    messageId: number,
    forwardType?: "forwardInline" | "forwardAsAttachment",
    details?: ComposeDetails,
  ): Promise<ComposeTab>;
  function getComposeDetails(tabId: number): Promise<ComposeDetailsResult>;
  function setComposeDetails(tabId: number, details: ComposeDetails): Promise<ComposeTab>;
  /** A new file attachment: a File (built in the background from base64) + display name. */
  interface FileAttachment {
    file?: File;
    name?: string;
  }
  /** The attachment as stored on the compose window. */
  interface ComposeAttachment {
    id: number;
    name?: string;
    size?: number;
  }
  /** Add a file attachment to an open compose window (does not send). */
  function addAttachment(tabId: number, attachment: FileAttachment): Promise<ComposeAttachment>;
}
