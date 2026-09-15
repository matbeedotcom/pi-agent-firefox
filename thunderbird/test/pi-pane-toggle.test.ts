import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the raw Experiment without Gecko. The pane operations are spies;
// window registration, click interception, tab selection and cleanup are real.
class NodeStub {
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, { fn: Function; capture: boolean }[]>();
  classList = {
    toggle: (key: string, value: boolean) => value ? this.classes.add(key) : this.classes.delete(key),
    remove: (key: string) => this.classes.delete(key),
  };
  removed = false;
  textContent = "";
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  removeAttribute(key: string) { this.attrs.delete(key); }
  appendChild(_node: unknown) {}
  remove() { this.removed = true; }
  addEventListener(event: string, fn: Function, capture = false) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, capture }]);
  }
  removeEventListener(event: string, fn: Function) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter(entry => entry.fn !== fn));
  }
  dispatch(event: string, button = 0) {
    let stopped = false;
    const e = { button, preventDefault() {}, stopImmediatePropagation() { stopped = true; } };
    for (const listener of [...(this.listeners.get(event) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
      listener.fn(e);
      if (stopped) break;
    }
  }
}

function mail(id: number) {
  const tab = { id, mode: { name: "mail3PaneTab" }, open: false,
    chromeBrowser: { contentDocument: { getElementById: (_id: string): unknown => tab.open ? {} : null } } };
  return tab;
}

function windowStub(firstId = 1) {
  const tabs = [mail(firstId), mail(firstId + 1), { id: firstId + 2, mode: { name: "contentTab" } }];
  const button = new NodeStub();
  const menu = new NodeStub();
  const win = new NodeStub();
  const tabmail = { currentTabInfo: tabs[0], tabInfo: tabs,
    switchToTab(tab: typeof tabs[number]) { this.currentTabInfo = tab; win.dispatch("TabSelect"); } };
  const nodes = new Map<string, unknown>([["tabmail", tabmail], ["pi-spacesButton-Pi", button], ["pi-spacesButton-Pi-menuitem", menu]]);
  let mutation = () => {};
  let disconnected = false;
  return Object.assign(win, { button, menu, tabmail, nodes,
    document: { documentElement: new NodeStub(), getElementById: (id: string) => nodes.get(id), createElementNS: () => new NodeStub() },
    gSpacesToolbar: { setFocusButton() {} },
    MutationObserver: class {
      constructor(fn: () => void) { mutation = fn; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    mutate: () => mutation(), disconnected: () => disconnected,
  });
}

function fixture() {
  const win = windowStub();
  let hooks: any;
  let cleanup: any;
  let registrations = 0;
  let unregistered = false;
  const calls: string[] = [];
  const allTabs = [...win.tabmail.tabInfo];
  const sandbox: any = {
    console,
    ExtensionCommon: { ExtensionAPI: class {}, makeWidgetId: () => "pi" },
    ChromeUtils: { importESModule: () => ({ ExtensionSupport: {
      registerWindowListener(_id: string, value: unknown) { registrations++; hooks = value; hooks.onLoadWindow(win); },
      unregisterWindowListener() { unregistered = true; },
    } }) },
  };
  runInNewContext(readFileSync(new URL("../../src/experiments/piPane/implementation.js", import.meta.url), "utf8"), sandbox);
  const api = new sandbox.piPane().getAPI({
    extension: { id: "pi", tabManager: { wrapTab: (tab: unknown) => tab } },
    callOnClose(value: unknown) { cleanup = value; },
  }).piPane;
  api.toggle = async (id: number) => { calls.push(`toggle:${id}`); const tab: any = allTabs.find(t => t.id === id); tab.open = !tab.open; };
  api.open = async (id: number) => { calls.push(`open:${id}`); (allTabs.find(t => t.id === id) as any).open = true; };
  api.close = (id: number) => { calls.push(`close:${id}`); (allTabs.find(t => t.id === id) as any).open = false; };
  api.registerSpaceButton("Pi");
  return { win, api, calls, cleanup, allTabs, hooks, registrations: () => registrations, unregistered: () => unregistered };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("Space button toggles the mail pane, suppresses tab opening and reflects state", async () => {
  const f = fixture();
  let nativeClicks = 0;
  f.win.button.addEventListener("click", () => nativeClicks++);
  f.win.button.dispatch("click");
  await settle();
  assert.deepEqual(f.calls, ["toggle:1"]);
  assert.equal(nativeClicks, 0);
  assert.equal(f.win.button.attrs.get("aria-pressed"), "true");
  assert.equal(f.win.button.classes.has("pi-pane-active"), true);
  f.win.menu.dispatch("command");
  await settle();
  assert.deepEqual(f.calls, ["toggle:1", "toggle:1"]);
  assert.equal(f.win.button.attrs.get("aria-pressed"), "false");
});

test("other tabs return to the last mail tab and open rather than close its pane", async () => {
  const f = fixture();
  f.win.tabmail.switchToTab(f.win.tabmail.tabInfo[1]);
  f.win.button.dispatch("click");
  await settle();
  f.win.tabmail.switchToTab(f.win.tabmail.tabInfo[2]);
  assert.equal(f.win.button.attrs.get("aria-pressed"), "false");
  f.win.button.dispatch("click");
  await settle();
  assert.equal(f.win.tabmail.currentTabInfo.id, 2);
  assert.deepEqual(f.calls, ["toggle:2", "open:2"]);
  // Closing the remembered mail tab falls back to a remaining mail tab.
  f.win.tabmail.switchToTab(f.win.tabmail.tabInfo[2]);
  f.win.tabmail.tabInfo.splice(1, 1);
  f.win.button.dispatch("click");
  await settle();
  assert.equal(f.win.tabmail.currentTabInfo.id, 1);
});

test("overlapping clicks do not race pane installation", async () => {
  const f = fixture();
  let release!: () => void;
  let count = 0;
  f.api.toggle = () => { count++; return new Promise<void>(resolve => { release = resolve; }); };
  f.win.button.dispatch("click");
  f.win.button.dispatch("click");
  assert.equal(count, 1);
  release();
  await settle();
  f.win.button.dispatch("click");
  assert.equal(count, 2);
  release();
  await settle();
});

test("registration handles new windows and late buttons, then removes hooks on unload", async () => {
  const f = fixture();
  f.api.registerSpaceButton("Pi");
  assert.equal(f.registrations(), 1);
  const second = windowStub(10);
  f.allTabs.push(...second.tabmail.tabInfo);
  second.nodes.delete("pi-spacesButton-Pi");
  f.hooks.onLoadWindow(second);
  second.nodes.set("pi-spacesButton-Pi", second.button);
  second.mutate();
  second.button.dispatch("click");
  await settle();
  assert.deepEqual(f.calls, ["toggle:10"]);
  assert.equal(f.win.button.attrs.get("aria-pressed"), "false");
  f.cleanup.close();
  assert.equal(f.unregistered(), true);
  assert.equal(second.disconnected(), true);
  assert.equal(second.button.attrs.has("aria-pressed"), false);
  const count = f.calls.length;
  second.button.dispatch("click");
  await settle();
  assert.equal(f.calls.length, count);
  assert.equal(f.cleanup.windows.size, 0);
});
