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
