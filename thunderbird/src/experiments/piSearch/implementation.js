/* piSearch Experiment — parent scope (addon_parent).
 *
 * Exposes Thunderbird's Gloda global message index — the SAME engine the
 * toolbar search bar uses (GlodaMsgSearcher: FTS3 over the live SQLite index,
 * term AND semantics, ranked results) — to the extension background.
 *
 * Why: WDAPI browser.messages.query({ fullText }) does a literal-substring
 * scan that takes 45–100 s on a ~19k-message mailbox for rare phrases
 * (verified live, .probe/engine-query-matrix.mjs). Gloda term lookups are
 * sub-second (search bar parity).
 *
 * API surface:
 *   browser.piSearch.searchMessages(text, { limit?, andTerms? })
 *     → Promise<Array<MessageHeader>>
 *       Standard WebExtension MessageHeaders (the same objects
 *       browser.messages.* returns, with the session-global `id` every other
 *       messages API takes), ranked by Gloda's relevance score
 *       (subject/attachment matches weigh most), resolved when the query
 *       completes (onQueryCompleted). Hits whose message is no longer in its
 *       folder (stale index rows) are dropped.
 *   browser.piSearch.status() → { enabled }
 *
 * Version coupling: imports GlodaMsgSearcher/GlodaPublic by resource: URI
 * (module layout verified on TB 153 ESR and 160 release); pin strict_max_version if
 * Gloda's internals ever move.
 */
"use strict";

(function (exports) {
  class PiSearch extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      // Lazy ESM imports — GlodaPublic's import initializes the GlodaIndexer
      // (app singleton; safe to import repeatedly, cached by the module loader).
      let glodaMsgSearcher = null;
      function searcherModule() {
        if (!glodaMsgSearcher) {
          glodaMsgSearcher = ChromeUtils.importESModule(
            "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs"
          );
        }
        return glodaMsgSearcher;
      }

      // GlodaMessage → WebExtension MessageHeader. A GlodaMessage has no
      // `uri`/`staticData`; its live nsIMsgDBHdr is `folderMessage` (null when
      // the index row is stale), and the extension's messageManager converts
      // that into the MessageHeader — including the session-global message
      // id that messages.get/getFull/move take. (A folder-local messageKey is
      // NOT a WebExtension message id.)
      function toHeader(item) {
        let hdr = null;
        try {
          hdr = item?.folderMessage ?? null;
        } catch {
          hdr = null;
        }
        if (!hdr) return null;
        try {
          return context.extension.messageManager.convert(hdr) ?? null;
        } catch {
          return null;
        }
      }

      function searchMessages(text, options = {}) {
        return new Promise((resolve, reject) => {
          if (typeof text !== "string" || !text.trim()) {
            reject(new Error("piSearch.searchMessages: text is required"));
            return;
          }
          const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
          const andTerms = options.andTerms !== false;

          const items = [];
          const listener = {
            onItemsAdded: (added) => {
              for (const item of added) {
                const header = toHeader(item);
                if (header) items.push(header);
              }
            },
            onItemsModified: () => {},
            onItemsRemoved: () => {},
            onQueryCompleted: () => resolve(items.slice(0, limit)),
          };

          try {
            const { GlodaMsgSearcher } = searcherModule();
            const searcher = new GlodaMsgSearcher(listener, text, andTerms);
            // Shadow the prototype getter (which reads the global search-limit
            // pref) with a per-call value.
            Object.defineProperty(searcher, "retrievalLimit", { value: limit });
            searcher.getCollection();
          } catch (e) {
            reject(e);
          }
        });
      }

      function status() {
        return {
          enabled: Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled", true),
        };
      }

      return {
        piSearch: {
          searchMessages,
          status,
        },
      };
    }
  }
  exports.piSearch = PiSearch;
})(this);
