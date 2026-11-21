/* trustedUaPane Experiment — parent scope (addon_parent).
 *
 * Native pane plumbing ONLY. Injects a 4th grid column (#trustedUaPane) into the
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
  // Keep Thunderbird's Space registration (keyboard navigation and overflow),
  // but route its primary activation to the mail pane instead of a content tab.
  class TrustedUaSpaceToggle {
    constructor(context, pane) {
      this.context = context;
      this.pane = pane;
      this.windows = new Map();
      this.listenerId = context.extension.id + ":tua-pane-toggle";
      this.support = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs").ExtensionSupport;
    }

    register(spaceName) {
      if (this.buttonId) return;
      this.buttonId = ExtensionCommon.makeWidgetId(this.context.extension.id) + "-spacesButton-" + spaceName;
      this.support.registerWindowListener(this.listenerId, {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: win => this.attach(win),
        onUnloadWindow: win => this.detach(win),
      });
    }

    attach(win) {
      if (this.windows.has(win)) return;
      const state = { lastMail: null, busy: false, bindings: new Map() };
      this.windows.set(win, state);
      state.sync = () => this.sync(win, state);
      state.observer = new win.MutationObserver(state.sync);
      state.observer.observe(win.document.documentElement, { childList: true, subtree: true });
      win.addEventListener("TabSelect", state.sync);
      const style = win.document.createElementNS("http://www.w3.org/1999/xhtml", "style");
      style.textContent = ".spaces-toolbar-button.tua-pane-active { background-color: var(--selected-item-color); color: var(--selected-item-text-color); }";
      win.document.documentElement.appendChild(style);
      state.style = style;
      this.sync(win, state);
    }

    sync(win, state) {
      const tab = win.document.getElementById("tabmail")?.currentTabInfo;
      if (tab?.mode.name === "mail3PaneTab") state.lastMail = tab;
      const open = tab?.mode.name === "mail3PaneTab" &&
        !!tab.chromeBrowser?.contentDocument?.getElementById("trustedUaPane");
      for (const [id, event] of [[this.buttonId, "click"], [this.buttonId + "-menuitem", "command"]]) {
        const button = win.document.getElementById(id);
        if (!button) continue;
        if (!state.bindings.has(button)) {
          const activate = e => {
            if (event === "click" && e.button !== 0) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            win.gSpacesToolbar.setFocusButton(win.document.getElementById(this.buttonId));
            this.activate(win, state).catch(error => console.error("[trustedUaPane] toolbar toggle failed", error));
          };
          button.addEventListener(event, activate, true);
          state.bindings.set(button, { event, activate });
        }
        button.setAttribute("aria-pressed", String(!!open));
        button.classList.toggle("tua-pane-active", !!open);
      }
    }

    async activate(win, state) {
      if (state.busy) return;
      const tabmail = win.document.getElementById("tabmail");
      const current = tabmail.currentTabInfo;
      const inMail = current?.mode.name === "mail3PaneTab";
      const remembered = tabmail.tabInfo.includes(state.lastMail) ? state.lastMail : null;
      const target = inMail ? current : remembered || tabmail.tabInfo.find(tab => tab.mode.name === "mail3PaneTab");
      if (!target) throw new Error("No mail tab is available for the Trusted Agent pane");
      state.busy = true;
      try {
        const tabId = this.context.extension.tabManager.wrapTab(target).id;
        if (inMail) {
          await this.pane.toggle(tabId);
        } else {
          tabmail.switchToTab(target);
          await this.pane.open(tabId);
        }
      } finally {
        state.busy = false;
        this.sync(win, state);
      }
    }

    refresh() {
      for (const [win, state] of this.windows) this.sync(win, state);
    }

    detach(win) {
      const state = this.windows.get(win);
      if (!state) return;
      state.observer.disconnect();
      win.removeEventListener("TabSelect", state.sync);
      for (const [button, { event, activate }] of state.bindings) {
        button.removeEventListener(event, activate, true);
        button.removeAttribute("aria-pressed");
        button.classList.remove("tua-pane-active");
      }
      state.style.remove();
      this.windows.delete(win);
    }

    close() {
      if (this.buttonId) this.support.unregisterWindowListener(this.listenerId);
      for (const win of this.windows.keys()) {
        for (const tab of win.document.getElementById("tabmail").tabInfo) {
          if (tab.mode.name === "mail3PaneTab") {
            this.pane.close(this.context.extension.tabManager.wrapTab(tab).id);
          }
        }
        this.detach(win);
      }
      this.buttonId = null;
    }
  }

  class TrustedUaPane extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      const PANE_ID = "trustedUaPane";
      const SPLITTER_ID = "trustedUaPaneSplitter";
      const STYLE_ID = "trustedUaPaneStyle";
      const OPEN_CLASS = "tua-pane-open";
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
        "#paneLayout.tua-pane-open { --tua-pane-width: " + DEFAULT_WIDTH + "px; }",
        "#trustedUaPane { grid-area: trustedUaPane; border: none; margin: 0; min-width: 0; min-height: 0; width: 100%; height: 100%; }",
        "#trustedUaPaneSplitter { grid-area: trustedUaPaneSplitter; border: none; border-left: 1px solid var(--splitter-bg, #cfd3da); width: 1px; min-width: 1px; margin: 0; }",
        "#paneLayout.tua-pane-open.layout-classic { grid-template: " +
          '"folders folderPaneSplitter threads threads threads" minmax(auto, 1fr) ' +
          '"folders folderPaneSplitter messagePaneSplitter messagePaneSplitter messagePaneSplitter" min-content ' +
          '"folders folderPaneSplitter message trustedUaPaneSplitter trustedUaPane" minmax(auto, var(--messagePaneSplitter-height)) ' +
          "/ minmax(auto, var(--folderPaneSplitter-width)) min-content minmax(auto, 1fr) min-content var(--tua-pane-width); }",
        "#paneLayout.tua-pane-open.layout-vertical { grid-template: " +
          '"folders folderPaneSplitter threads messagePaneSplitter message trustedUaPaneSplitter trustedUaPane" auto ' +
          "/ minmax(auto, var(--folderPaneSplitter-width)) min-content minmax(auto, 1fr) min-content minmax(auto, var(--messagePaneSplitter-width)) min-content var(--tua-pane-width); }",
        "#paneLayout.tua-pane-open.layout-wide { grid-template: " +
          '"folders folderPaneSplitter threads threads threads" minmax(auto, 1fr) ' +
          '"messagePaneSplitter messagePaneSplitter messagePaneSplitter messagePaneSplitter messagePaneSplitter" min-content ' +
          '"message message message trustedUaPaneSplitter trustedUaPane" minmax(auto, var(--messagePaneSplitter-height)) ' +
          "/ minmax(auto, var(--folderPaneSplitter-width)) min-content minmax(auto, 1fr) min-content var(--tua-pane-width); }",
      ].join("\n");

      // Wrap an error in a WebExtension context.Error so the API layer forwards
      // the REAL message to the caller instead of sanitizing it.
      function err(phase, e) {
        const detail = e && e.message ? e.message : String(e);
        const top = e && e.stack ? String(e.stack).split("\n").slice(0, 2).join(" ") : "";
        const msg = "trustedUaPane " + phase + ": " + detail + (top ? " | " + top : "");
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
        toolbar.refresh();

        // Force construction of the frame loader (Gecko's extension code does this).
        try { pane.getBoundingClientRect(); } catch (_e) {}
        await frameLoaderReady;
        try { pane.docShellIsActive = true; } catch (_e) {}

        // Register with the WebExtension machinery BEFORE navigation, then load
        // the pane page via Thunderbird's loader (handles process / remoteness).
        try {
          ExtensionParent.apiManager.emit("extension-browser-inserted", pane);
        } catch (e) {
          console.warn("[trustedUaPane] extension-browser-inserted err: " + e);
        }
        try {
          MailE10SUtils.loadURI(pane, url);
          console.info("[trustedUaPane] loaded extension-view pane: " + url);
        } catch (e) {
          console.warn("[trustedUaPane] MailE10SUtils.loadURI err: " + e);
        }

        // DIAGNOSTIC: did the pane page load?
        ap.win.setTimeout(() => {
          try {
            const cw = pane.contentWindow;
            const t = cw && cw.document ? cw.document.title : "?";
            const h = cw && cw.location ? cw.location.href : "?";
            console.info("[trustedUaPane] load-check: contentWindow=" + (cw ? "obj" : String(cw)) + " title=" + t + " href=" + h);
          } catch (e) {
            console.info("[trustedUaPane] load-check err: " + e);
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
        toolbar.refresh();
      }

      function setWidthPx(tabId, width) {
        const ap = getAbout3Pane(tabId);
        if (!ap) return;
        gridContainer(ap.doc).style.setProperty(
          "--tua-pane-width",
          Math.max(MIN_WIDTH, Math.round(width)) + "px",
        );
      }

      function readWidth(ap) {
        if (!ap) return undefined;
        // No bare DOM globals in the privileged parent scope: use the window we
        // pulled from the tab (ap.win) for getComputedStyle.
        const el = gridContainer(ap.doc);
        const val = ap.win.getComputedStyle(el).getPropertyValue("--tua-pane-width").trim();
        const n = parseInt(val, 10);
        return Number.isFinite(n) ? n : undefined;
      }

      function getState(tabId) {
        const ap = getAbout3Pane(tabId);
        const open = !!(ap && isOpen(ap.doc));
        const width = readWidth(ap);
        return { open: open, tabId: tabId, ...(width !== undefined ? { width: width } : {}) };
      }

      const api = {
        trustedUaPane: {
          registerSpaceButton(spaceName) {
            toolbar.register(spaceName);
          },
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
      const toolbar = new TrustedUaSpaceToggle(context, api.trustedUaPane);
      context.callOnClose(toolbar);
      return api;
    }
  }
  exports.trustedUaPane = TrustedUaPane;
})(this);
