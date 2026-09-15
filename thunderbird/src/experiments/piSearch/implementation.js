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
 *     → Promise<Array<{ uri, folderUri, messageKey, subject?, date? }>>
 *       ranked by Gloda's relevance score (subject/attachment matches weigh
 *       most), resolved when the query completes (onQueryCompleted).
 *   browser.piSearch.status() → { enabled }
 *
 * Version coupling: imports GlodaMsgSearcher/GlodaPublic by resource: URI
 * (module layout is stable across TB 115–155); pin strict_max_version if
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

      function mapItem(item) {
        const uri = typeof item?.uri === "string" ? item.uri : "";
        const keyMatch = /:(\d+)$/.exec(uri);
        const staticData = item?.staticData ?? {};
        return {
          uri,
          folderUri: typeof item?.folderUri === "string" ? item.folderUri : "",
          messageKey: keyMatch ? Number(keyMatch[1]) : undefined,
          subject: typeof staticData.subject === "string" ? staticData.subject : undefined,
          // Gloda stores PRTime (microseconds)
          date: typeof staticData.date === "number" ? staticData.date : undefined,
        };
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
              for (const item of added) items.push(mapItem(item));
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
