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
5. On allow, the host proceeds to capture (`browser.tabs.captureTab(tab.id)` —
   the specific tab, no OS-focus dependency — with `captureVisibleTab` as
   fallback). On deny/timeout, the tool returns a structured
   `BROWSER_PERMISSION_DENIED` and **never reaches the dispatcher**.

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
- **Live verification pending**: requires the temp add-on reload so the agent's
  `browser_screenshot` triggers the sidebar approval modal. Whether the capture
  then succeeds on a *temp* add-on depends on Firefox honoring the gesture for
  host access; if it still reports missing host permission, the definitive fix
  is a **permanent (non-temp) install** on a non-signing-enforced build, where
  `captureTab` + `<all_urls>` works directly (see load options discussed with
  the user).

## Capture path (tool-dispatcher.ts → screenshot)

1. `browser.tabs.captureTab(tab.id, {format, quality})` — captures the specific
   tab's rendered surface; no OS-focus dependency. (Needs `<all_urls>`.)
2. Fallback: `browser.tabs.captureVisibleTab({…})` / `(windowId, {…})` with a
   growing-settle retry loop (window focus is delivered async by the WM on
   Linux).
3. If all fail: structured `BROWSER_PERMISSION_DENIED`.
