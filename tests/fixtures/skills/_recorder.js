/*
 * _recorder.js — shared fixture recorder (skills E2E fixtures).
 *
 * Included by EVERY fixture page. It is the ONLY channel the test driver
 * uses to observe page outcomes:
 *
 * - window.__fixture.log          — chronological record of fixture events
 * - window.__fixture.markSubmitted(draft)
 *                                 — a submit SUCCEEDED: sets
 *                                   body[data-submitted="1"], reveals
 *                                   #receipt, records {type:"submitted"}
 * - window.__fixture.record(type, detail)
 *                                 — record any other fixture event
 * - window.__fixture.reset()      — clear log, receipt, data-submitted
 *
 * The <pre id="fixture-log"> element (rendered by each page) shows the log
 * as JSON; the driver can also read window.__fixture.log directly.
 */
(function () {
  "use strict";
  // The e2e harness serves the fixtures with ?skills_test=1 and observes
  // every recorder event through POST /__report (same origin). Inert on a
  // plain file:// or unmarked page (the beacon target is same-origin only).
  const autoReport = /[?&]skills_test=1\b/.test(location.search) && location.protocol !== "file:";
  function beacon() {
    if (!autoReport) return;
    const body = JSON.stringify({
      url: location.pathname,
      log: fixture.log,
      submitted: document.body.getAttribute("data-submitted"),
      receipt: (document.getElementById("receipt") || {}).textContent || null,
    });
    try { fetch(location.origin + "/__report", { method: "POST", body: body, keepalive: true }).catch(function () {}); } catch (err) { /* non-fatal */ }
  }
  const fixture = {
    log: [],
    record(type, detail) {
      this.log.push({ type: type, detail: detail === undefined ? null : detail, at: Date.now() });
      const el = document.getElementById("fixture-log");
      if (el) el.textContent = JSON.stringify(this.log, null, 1);
      beacon();
    },
    markSubmitted(draft) {
      document.body.setAttribute("data-submitted", "1");
      const r = document.getElementById("receipt");
      if (r) {
        r.hidden = false;
        r.textContent = "SUBMITTED: " + draft + " at " + new Date().toISOString();
      }
      this.record("submitted", { draft: draft });
      beacon();
    },
    reset() {
      document.body.removeAttribute("data-submitted");
      this.log = [];
      const r = document.getElementById("receipt");
      if (r) {
        r.hidden = true;
        r.textContent = "";
      }
      const el = document.getElementById("fixture-log");
      if (el) el.textContent = "";
    },
  };
  window.__fixture = fixture;

  // e2e page-world skills bridge (skills_test=1 only).
  //
  // The add-on's test router lives in the content script's ISOLATED world
  // (window.__skillsTest is not visible from the page's JS world); this
  // wrapper is the page-world entry point: it round-trips through
  // window.postMessage (which crosses the world boundary in Firefox), so
  // browser_evaluate — which runs in the page world, where window.__fixture
  // also lives — can drive the same background dispatch the review UI uses.
  if (autoReport && window.top === window) {
    (function () {
      var seq = 0;
      var pending = {};
      window.addEventListener("message", function (event) {
        var d = event.data;
        if (d && typeof d === "object" && d.__skillsTestTrace !== undefined) { fixture.record("trace", d); return; }
        // One-way content-world diagnostics (e2e only; recorder is a test fixture).
        if (d && typeof d === "object" && d.__skillsTestRecord) { fixture.record(d.__skillsTestRecord.type, d.__skillsTestRecord.detail ?? null); return; }
        if (!d || d.__skillsTestReply !== true || !Object.prototype.hasOwnProperty.call(pending, d.id)) return;
        var p = pending[d.id];
        delete pending[d.id];
        if (d.ok) p.resolve(d.result);
        else p.reject(new Error(d.error || "skills test action failed"));
      });
      window.__skillsTest = {
        action: function (name, payload) {
          var id = ++seq;
          return new Promise(function (resolve, reject) {
            pending[id] = { resolve: resolve, reject: reject };
            setTimeout(function () {
              if (pending[id]) { delete pending[id]; reject(new Error("skills test action timed out: " + name)); }
            }, 30000);
            window.postMessage({ __skillsTest: true, id: id, name: name, payload: payload || {} }, "*");
          });
        },
        state: function () { return this.action("skills_state"); },
        fixture: function () { return window.__fixture; },
      };
    })();
  }

  // e2e auto-driver (skills_test=1 only): the fixture page opens its own
  // session, binds itself, and sends the scripted prompt. The prompt text
  // comes from the skills_test_prompt query param and must match the fake
  // host's mock-script entry. Driver progress is recorded (beaconed) so the
  // harness observes it through /__report.
  function autoDrive() {
    if (!autoReport) return;
    var promptText = new URLSearchParams(location.search).get("skills_test_prompt");
    if (!promptText) return;
    // Give the content script (document_idle) time to register its
    // postMessage router before the first round-trip.
    setTimeout(run, 500);
    function run() {
    if (!window.__skillsTest) return;
    const step = (name, detail) =>
      fixture.record("driver", { step: name, detail: detail === undefined ? null : detail });
    (async () => {
      try {
        step("start", { csProbe: document.documentElement.getAttribute("data-cs-probe") });
        const s = (await window.__skillsTest.action("new_session", { cwd: "/tmp" })) || {};
        const sessionId = s.sessionId;
        if (!sessionId) throw new Error("no sessionId: " + JSON.stringify(s));
        step("session", { sessionId });
        await window.__skillsTest.action("bind_current_tab", { sessionId });
        step("bound");
        step("prompted", { text: promptText, result: await window.__skillsTest.action("prompt", { sessionId, text: promptText }) });
      } catch (err) {
        step("driver-error", { message: String(err) });
      }
    })();
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoDrive);
  else autoDrive();
})();
