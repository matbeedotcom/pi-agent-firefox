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
  const fixture = {
    log: [],
    record(type, detail) {
      this.log.push({ type: type, detail: detail === undefined ? null : detail, at: Date.now() });
      const el = document.getElementById("fixture-log");
      if (el) el.textContent = JSON.stringify(this.log, null, 1);
    },
    markSubmitted(draft) {
      document.body.setAttribute("data-submitted", "1");
      const r = document.getElementById("receipt");
      if (r) {
        r.hidden = false;
        r.textContent = "SUBMITTED: " + draft + " at " + new Date().toISOString();
      }
      this.record("submitted", { draft: draft });
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
})();
