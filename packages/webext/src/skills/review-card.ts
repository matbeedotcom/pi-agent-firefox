/**
 * Unified decision UI for a held submission (skills-runtime-design.md §179–191).
 *
 * One card, per document/interaction, aggregates every required reviewer.
 * Rendering is a pure function of the SubmissionGate's view: the gate is
 * the single source of truth for state, staleness, and authorization. The
 * card NEVER posts, NEVER clears the gate, and never trusts a model-supplied
 * identity — it only surfaces decisions and routes the user's explicit
 * choices back to the gate via the injected callbacks.
 *
 * Advisory mode is informational: it never holds an action, so the card
 * shows suggestions and dismiss, but no "hold" framing and no bypass.
 */
import { activityNode } from "../activity/activity-result-view.js";
import type { GateView, GateState } from "./submission-gate.js";
import type { ReviewResult } from "@trusted-ua/protocol";

export interface ReviewCardOptions {
  mode: "advisory" | "review-before-submit";
  /** Display name for a skill key (falls back to the key itself). */
  skillName?: (skillKey: string) => string;
  /** User applies one suggestion: the caller edits the draft, which
   *  invalidates the prior review (gate.update). Never implies submit. */
  onApplySuggestion?: (result: ReviewResult) => void;
  /** User keeps their own text / bypasses an unavailable required review. */
  onAuthorize?: () => void;
  /** Dismiss the card without changing the draft (advisory). */
  onDismiss?: () => void;
}

interface SuggestionEntry {
  result: ReviewResult;
  details: HTMLDetailsElement;
}

const STATE_LABEL: Record<GateState, string> = {
  dirty: "Not yet reviewed",
  reviewing: "Reviewing…",
  clear: "No changes suggested",
  suggestion: "Changes suggested",
  unavailable: "Review unavailable",
  authorized: "Cleared to post",
  closed: "",
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function createReviewCard(opts: ReviewCardOptions): {
  wrap: HTMLElement;
  update: (view: GateView) => void;
} {
  const wrap = activityNode("div", "review-card");
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Submission review");

  const head = activityNode("div", "review-head");
  const title = activityNode("span", "review-title");
  const statusDot = activityNode("span", "review-dot");
  head.append(statusDot, title);

  const body = activityNode("div", "review-body");
  const note = activityNode("p", "review-note");
  const suggestionList = activityNode("div", "review-suggestions");
  const actions = activityNode("div", "review-actions");
  body.append(note, suggestionList, actions);
  wrap.append(head, body);

  const name = (key: string) => opts.skillName?.(key) ?? key;
  let suggestionKey = "";

  const renderSuggestions = (suggestions: ReviewResult[]) => {
    suggestionList.replaceChildren();
    for (const result of suggestions) {
      const entry: SuggestionEntry = { result, details: document.createElement("details") };
      entry.details.className = "review-suggestion";
      const summary = activityNode("summary", "review-suggestion-summary");
      summary.append(
        activityNode("span", "review-suggestion-name", name(result.skillKey)),
        activityNode("span", "review-suggestion-decision", "suggest"),
      );
      const content = activityNode("div", "review-suggestion-content");
      if (result.explanation) {
        content.append(activityNode("p", "review-suggestion-explanation", result.explanation));
      }
      if (result.replacementText) {
        content.append(
          activityNode("span", "review-suggestion-preview-label", "Suggested replacement"),
          activityNode("pre", "review-suggestion-preview", truncate(result.replacementText, 1200)),
        );
      }
      entry.details.append(summary, content);
      suggestionList.append(entry.details);
    }
  };

  const button = (className: string, text: string, onClick: () => void): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className;
    el.textContent = text;
    el.onclick = onClick;
    return el;
  };

  // Advisory is informational: it never holds an action, so the card offers
  // "use this text" (draft edit) and dismiss — never a bypass.
  const renderAdvisoryActions = (view: GateView) => {
    if (view.state === "suggestion" && opts.onApplySuggestion && view.suggestions[0]) {
      const first = view.suggestions[0];
      actions.append(button("review-apply", "Use this text", () => opts.onApplySuggestion?.(first)));
    }
    if (opts.onDismiss) actions.append(button("review-dismiss", "Dismiss", () => opts.onDismiss?.()));
  };

  // review-before-submit: the gate holds the action until resolved. Any
  // suggestion holds; the user resolves by applying one or keeping their text.
  const renderReviewActions = (view: GateView) => {
    if (view.state === "suggestion" && opts.onApplySuggestion) {
      for (const result of view.suggestions) {
        actions.append(button("review-apply", `Use ${name(result.skillKey)}`, () => opts.onApplySuggestion?.(result)));
      }
    }
    if (["suggestion", "unavailable", "reviewing", "dirty"].includes(view.state) && opts.onAuthorize) {
      actions.append(
        button(
          view.state === "unavailable" ? "review-bypass" : "review-keep",
          view.state === "unavailable" ? "Bypass and continue" : "Keep my text",
          () => opts.onAuthorize?.(),
        ),
      );
    }
  };

  const renderActions = (view: GateView) => {
    actions.replaceChildren();
    if (opts.mode === "advisory") renderAdvisoryActions(view);
    else renderReviewActions(view);
  };

  const update = (view: GateView) => {
    wrap.dataset.state = view.state;
    title.textContent = STATE_LABEL[view.state];
    note.textContent = view.reason ?? (opts.mode === "advisory" && view.state === "suggestion" ? "Advisory — posting is not held." : "");
    note.hidden = !note.textContent;
    const key = view.suggestions.map((s) => `${s.jobId}:${s.skillRevision}:${s.replacementText ?? ""}`).join("|");
    if (key !== suggestionKey) {
      suggestionKey = key;
      renderSuggestions(view.suggestions);
    }
    renderActions(view);
    wrap.hidden = view.state === "closed";
  };

  return { wrap, update };
}
