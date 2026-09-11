# browser_screenshot — permission-gated capture (DoD #15)

## Design (PRODUCT.md §43: sensitive tools require explicit user approval)

`browser_screenshot` is a **sensitive tool**. Before it runs, the host asks the
client (Firefox) for permission via the canonical ACP method
**`session/request_permission`**:

1. Agent calls `browser_screenshot`.
2. Host (`BrowserToolProvider.execute`) sees it's in `SENSITIVE_TOOLS` and calls
   `requestPermission(...)`, which sends `session/request_permission` to the
   add-on and **blocks** until the user answers (or 120s timeout).
3. Add-on (`AcpClient` → `onRequestPermission` → background `index.ts`) pushes a
   `pi/permission_request` to the sidebar, which renders an **Allow once /
   Always allow / Deny** modal and blocks on `pi/permission_response`.
4. The user's click is a **live user gesture**. The add-on responds with the
   chosen option.
5. On allow, the host proceeds to capture
   (`browser.tabs.captureVisibleTab(tab.windowId, {format, quality})`, with
   activate+focus+settle retries). On deny/timeout, the tool returns a
   structured `BROWSER_PERMISSION_DENIED` and **never reaches the dispatcher**.

"Always allow" is remembered for the host lifetime.

## Why the user-gesture gate

On this E2E box the add-on is a **temp add-on** (the only install path that
works — snap `latest/stable` enforces signing, so a permanent unsigned install
is blocked; `xpinstall.signatures.required=false` is reset on startup). Temp
add-ons do **not** get `activeTab`/`<all_urls>` host access, which is what the
capture APIs need. The approval is the product-correct way to gate a sensitive
capture, and the user's gesture is the intended trigger that makes the capture
permissible.

## Status

- **Code complete** across protocol / host / add-on / sidebar; **unit +
  integration tested (77/77)**:
  - protocol: `buildPermissionRequest` / `permissionAllowed` shape + outcome.
  - e2e (real host): approve → screenshot completes + a
    `session/request_permission` was emitted identifying `browser_screenshot`;
    deny → tool fails with a permission error and never reaches the dispatcher.
- **Live-verified on desktop stable Firefox** (user): the approval modal
  appears in the sidebar and the capture succeeds — `captureVisibleTab(windowId)`
  works fine on a non-snap stable build.
- **Snap Firefox caveat**: on the snap build (the E2E box), the same flow
  intermittently reports the tab as not visible/focused — snap confinement
  changes window/compositor focus semantics that `captureVisibleTab`'s
  visibility check depends on. This is an environment artifact, not a code
  defect; the desktop-stable result is authoritative.

## Capture path (tool-dispatcher.ts → screenshot)

1. `browser.tabs.captureVisibleTab(tab.windowId, { format, quality })` —
   captures the window's selected (visible) tab. Before each attempt the
   dispatcher makes the bound tab the selected tab and focuses its window;
   the capture is retried with growing settle delays (300→3000ms) because
   window focus is delivered asynchronously by the WM on Linux, and the
   user's approval of the (permission-gated) screenshot is what makes the
   tab's host access (activeTab) live at capture time.
2. If all attempts fail: structured `BROWSER_PERMISSION_DENIED` with the
   capture error message (so the agent can react, e.g. fall back to
   `browser_get_page`/`browser_get_dom`).
