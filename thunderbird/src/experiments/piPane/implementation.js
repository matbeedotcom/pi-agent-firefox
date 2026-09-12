/* piPane Experiment — parent scope (addon_parent).
 *
 * Native pane plumbing ONLY. Injects a 4th grid column (#piPane) into the
 * about:3pane document beside the message pane, hosting the extension's shared
 * sidepanel UI (space/index.html). It patches the existing about:3pane CSS grid
 * (named areas) rather than overlaying the email, so the message list keeps its
 * full width and Pi consumes horizontal space only beside the message.
 *
 * All ACP / session / mail logic stays in the normal extension background; this
 * module just manipulates Thunderbird's native UI, so Thunderbird-version
 * breakage is isolated here.
 *
 * Module contract (see thundermail api/MailAccounts/implementation.js): the
 * export is a class extending ExtensionCommon.ExtensionAPI whose getAPI(context)
 * returns the API object keyed by the namespace. `context` is a getAPI parameter
 * (NOT a free variable). Access path (as in ext-mailTabs.js):
 *   context.extension.tabManager.get(tabId).nativeTab.chromeBrowser.contentWindow
 * The about:3pane grid container is <body id="paneLayout"> (HTML-rooted doc;
 * XUL is a prefixed namespace, so the pane uses createElementNS(XUL_NS,"browser")
 * like the existing #webBrowser).
 */
"use strict";

(function (exports) {
  class PiPane extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      const PANE_ID = "piPane";
      const SPLITTER_ID = "piPaneSplitter";
      const STYLE_ID = "piPaneStyle";
      const OPEN_CLASS = "pi-pane-open";
      const GRID_CONTAINER_ID = "paneLayout";
      const HTML_NS = "http://www.w3.org/1999/xhtml";
      // about:3pane is HTML-rooted with XUL as a prefixed namespace (see
      // <xul:browser id="webBrowser">). A XUL <browser> is the same element
      // Thunderbird uses to render the message, so it is the safe way to embed
      // the Pi sidepanel UI here.
      const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
      const MIN_WIDTH = 180;
      const DEFAULT_WIDTH = 320;

      const GRID_CSS = [
        "#paneLayout.pi-pane-open { --pi-pane-width: " + DEFAULT_WIDTH + "px; }",
        "#piPane { grid-area: piPane; border: none; margin: 0; min-width: 0; min-height: 0; width: 100%; height: 100%; }",
        "#piPaneSplitter { grid-area: piPaneSplitter; border: none; border-left: 1px solid var(--splitter-bg, #cfd3da); width: 1px; min-width: 1px; margin: 0; }",
        "#paneLayout.pi-pane-open.layout-classic { grid-template: " +
          '"folders folderPaneSplitter threads threads threads" minmax(auto, 1fr) ' +
          '"folders folderPaneSplitter messagePaneSplitter messagePaneSplitter messagePaneSplitter" min-content ' +
          '"folders folderPaneSplitter message piPaneSplitter piPane" minmax(auto, var(--messagePaneSplitter-height)) ' +
          "/ minmax(auto, var(--folderPaneSplitter-width)) min-content minmax(auto, 1fr) min-content var(--pi-pane-width); }",
        "#paneLayout.pi-pane-open.layout-vertical { grid-template: " +
          '"folders folderPaneSplitter threads messagePaneSplitter message piPaneSplitter piPane" auto ' +
          "/ minmax(auto, var(--folderPaneSplitter-width)) min-content minmax(auto, 1fr) min-content minmax(auto, var(--messagePaneSplitter-width)) min-content var(--pi-pane-width); }",
        "#paneLayout.pi-pane-open.layout-wide { grid-template: " +
          '"folders folderPaneSplitter threads threads threads" minmax(auto, 1fr) ' +
          '"messagePaneSplitter messagePaneSplitter messagePaneSplitter messagePaneSplitter messagePaneSplitter" min-content ' +
          '"message message message piPaneSplitter piPane" minmax(auto, var(--messagePaneSplitter-height)) ' +
          "/ minmax(auto, var(--folderPaneSplitter-width)) min-content minmax(auto, 1fr) min-content var(--pi-pane-width); }",
      ].join("\n");

      // Wrap an error in a WebExtension context.Error so the API layer forwards
      // the REAL message to the caller instead of sanitizing it.
      function err(phase, e) {
        const detail = e && e.message ? e.message : String(e);
        const top = e && e.stack ? String(e.stack).split("\n").slice(0, 2).join(" ") : "";
        const msg = "piPane " + phase + ": " + detail + (top ? " | " + top : "");
        try {
          return new context.Error(msg);
        } catch (_c) {
          return new Error(msg);
        }
      }

      function gridContainer(doc) {
        return doc.getElementById(GRID_CONTAINER_ID) || doc.body;
      }

      function getAbout3Pane(tabId) {
        let tab;
        try {
          tab = context.extension.tabManager.get(tabId);
        } catch (e) {
          throw err("tabManager.get(" + tabId + ")", e);
        }
        const native = tab && tab.nativeTab;
        if (!native || native.closed) return null;
        if (!native.mode || native.mode.name !== "mail3PaneTab") return null;
        const win = native.chromeBrowser && native.chromeBrowser.contentWindow;
        if (!win || !win.document) return null;
        return { win: win, doc: win.document };
      }

      function isOpen(doc) {
        return !!doc.getElementById(PANE_ID);
      }

      async function installPane(tabId) {
        const ap = getAbout3Pane(tabId);
        if (!ap) throw err("installPane", "tab " + tabId + " is not an open mail 3-pane tab");
        const doc = ap.doc;
        if (isOpen(doc)) return;

        // Privileged modules that turn a plain <browser> into a WebExtension view
        // (so the loaded pane page gets browser.runtime / storage, etc.).
        let ExtensionParent;
        let MailE10SUtils;
        try {
          ExtensionParent = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs").ExtensionParent;
          MailE10SUtils = ChromeUtils.importESModule("resource://gre/modules/MailE10SUtils.sys.mjs").MailE10SUtils;
        } catch (e) {
          throw err("installPane.imports", e);
        }

        const style = doc.createElementNS(HTML_NS, "style");
        style.id = STYLE_ID;
        style.textContent = GRID_CSS;
        (doc.head || doc.documentElement).appendChild(style);

        const splitter = doc.createElementNS(HTML_NS, "hr");
        splitter.id = SPLITTER_ID;

        const ext = context.extension;
        const url = ext.baseURI.resolve("pane/index.html?tabId=" + tabId);

        // A real XUL <browser> configured EXACTLY like Gecko's own WebExtension
        // browsers (HiddenExtensionPage). The messagemanagergroup + construction
        // sequence are what make Gecko instantiate it as an extension context and
        // export the `browser` global into the loaded page.
        const pane =
          typeof doc.createXULElement === "function"
            ? doc.createXULElement("browser")
            : doc.createElementNS(XUL_NS, "browser");
        pane.id = PANE_ID;
        pane.setAttribute("type", "content");
        pane.setAttribute("disableglobalhistory", "true");
        pane.setAttribute("messagemanagergroup", "webext-browsers");
        pane.setAttribute("manualactiveness", "true");
        pane.setAttribute("nodefaultsrc", "true");
        pane.setAttribute("maychangeremoteness", "true");
        pane.setAttribute("webextension-view-type", "sidebar");
        if (ext.remote) {
          pane.setAttribute("remote", "true");
          pane.setAttribute("remoteType", ext.remoteType);
        }
        if (ext.browsingContextGroupId != null) {
          pane.setAttribute("initialBrowsingContextGroupId", String(ext.browsingContextGroupId));
        }

        // Wait for the frame loader to be created (remote case) before loading.
        let frameLoaderReady = Promise.resolve();
        if (ext.remote) {
          frameLoaderReady = new Promise((resolve) => {
            pane.addEventListener("XULFrameLoaderCreated", resolve, { once: true });
          });
        }

        const body = gridContainer(doc);
        body.append(splitter, pane);
        body.classList.add(OPEN_CLASS);

        // Force construction of the frame loader (Gecko's extension code does this).
        try { pane.getBoundingClientRect(); } catch (_e) {}
        await frameLoaderReady;
        try { pane.docShellIsActive = true; } catch (_e) {}

        // Register with the WebExtension machinery BEFORE navigation, then load
        // the pane page via Thunderbird's loader (handles process / remoteness).
        try {
          ExtensionParent.apiManager.emit("extension-browser-inserted", pane);
        } catch (e) {
          console.warn("[piPane] extension-browser-inserted err: " + e);
        }
        try {
          MailE10SUtils.loadURI(pane, url);
          console.info("[piPane] loaded extension-view pane: " + url);
        } catch (e) {
          console.warn("[piPane] MailE10SUtils.loadURI err: " + e);
        }

        // DIAGNOSTIC: did the pane page load?
        ap.win.setTimeout(() => {
          try {
            const cw = pane.contentWindow;
            const t = cw && cw.document ? cw.document.title : "?";
            const h = cw && cw.location ? cw.location.href : "?";
            console.info("[piPane] load-check: contentWindow=" + (cw ? "obj" : String(cw)) + " title=" + t + " href=" + h);
          } catch (e) {
            console.info("[piPane] load-check err: " + e);
          }
        }, 2000);
      }

      function removePane(tabId) {
        const ap = getAbout3Pane(tabId);
        if (!ap) return;
        const doc = ap.doc;
        const pane = doc.getElementById(PANE_ID);
        if (pane) pane.remove();
        const splitter = doc.getElementById(SPLITTER_ID);
        if (splitter) splitter.remove();
        const style = doc.getElementById(STYLE_ID);
        if (style) style.remove();
        gridContainer(doc).classList.remove(OPEN_CLASS);
      }

      function setWidthPx(tabId, width) {
        const ap = getAbout3Pane(tabId);
        if (!ap) return;
        gridContainer(ap.doc).style.setProperty(
          "--pi-pane-width",
          Math.max(MIN_WIDTH, Math.round(width)) + "px",
        );
      }

      function readWidth(ap) {
        if (!ap) return undefined;
        // No bare DOM globals in the privileged parent scope: use the window we
        // pulled from the tab (ap.win) for getComputedStyle.
        const el = gridContainer(ap.doc);
        const val = ap.win.getComputedStyle(el).getPropertyValue("--pi-pane-width").trim();
        const n = parseInt(val, 10);
        return Number.isFinite(n) ? n : undefined;
      }

      function getState(tabId) {
        const ap = getAbout3Pane(tabId);
        const open = !!(ap && isOpen(ap.doc));
        const width = readWidth(ap);
        return { open: open, tabId: tabId, ...(width !== undefined ? { width: width } : {}) };
      }

      return {
        piPane: {
          open(tabId) {
            return installPane(tabId)
              .then(() => ({}))
              .catch((e) => {
                throw err("open", e);
              });
          },
          close(tabId) {
            return new Promise((resolve, reject) => {
              try {
                removePane(tabId);
                resolve({});
              } catch (e) {
                reject(err("close", e));
              }
            });
          },
          toggle(tabId) {
            const open = getState(tabId).open;
            const action = open ? Promise.resolve(removePane(tabId)) : installPane(tabId);
            return action
              .then(() => ({ open: getState(tabId).open, tabId: tabId }))
              .catch((e) => {
                throw err("toggle", e);
              });
          },
          setWidth(tabId, width) {
            return new Promise((resolve, reject) => {
              try {
                setWidthPx(tabId, width);
                resolve({});
              } catch (e) {
                reject(err("setWidth", e));
              }
            });
          },
          getState(tabId) {
            return new Promise((resolve, reject) => {
              try {
                resolve(getState(tabId));
              } catch (e) {
                reject(err("getState", e));
              }
            });
          },
        },
      };
    }
  }
  exports.piPane = PiPane;
})(this);
