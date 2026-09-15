import { record, type ResultView, type ResultRow } from "./activity-result.js";

export function activityNode(tag: string, className: string, text = ""): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

/** A bounded inspector; expanding containers is native, keyboard-accessible UI. */
function valueNode(value: unknown, depth = 0, budget = { remaining: 160 }): HTMLElement {
  if (--budget.remaining < 0) return activityNode("span", "result-caption", "Preview limit reached; full result below");
  if (value === null || typeof value !== "object" || depth >= 4) {
    return activityNode("pre", "result-scalar", typeof value === "string" ? value.slice(0, 12000) : String(JSON.stringify(value) ?? "undefined").slice(0, 12000));
  }
  const entries = Object.entries(value);
  const group = activityNode("div", "result-properties");
  for (const [key, item] of entries.slice(0, 40)) {
    if (budget.remaining <= 0) break;
    const details = document.createElement("details");
    const summary = activityNode("summary", "result-property", key);
    details.append(summary, valueNode(item, depth + 1, budget));
    group.append(details);
  }
  if (!entries.length) group.append(activityNode("span", "result-empty", Array.isArray(value) ? "Empty list" : "Empty object"));
  if (entries.length > 40 || budget.remaining <= 0) group.append(activityNode("p", "result-caption", "Preview limited; full result below"));
  return group;
}

function resultRow(row: ResultRow, maxDuration: number): HTMLElement {
  const li = activityNode("li", "result-row");
  if (row.tone) li.dataset.tone = row.tone;
  const content = activityNode("div", "result-row-content");
  content.append(activityNode("div", "result-row-label", row.label));
  if (row.detail) content.append(activityNode("div", "result-caption", row.detail));
  li.append(activityNode("span", "result-badge", row.badge), content);
  if (row.duration !== undefined) {
    const meter = document.createElement("meter");
    meter.max = maxDuration;
    meter.value = row.duration;
    meter.setAttribute("aria-label", `Request duration ${row.duration} milliseconds`);
    content.append(meter, activityNode("span", "result-duration", `${row.duration} ms`));
  }
  return li;
}

export function appendResultView(parent: HTMLElement, view: ResultView): void {
  const section = activityNode("section", `activity-result result-${view.kind}`);
  section.append(activityNode("h4", "result-heading", view.heading));
  if (view.caption) section.append(activityNode("p", "result-caption", view.caption));
  if (view.rows) {
    const list = activityNode("ul", "result-list");
    const maximum = Math.max(1, ...view.rows.map((row) => row.duration ?? 0));
    for (const row of view.rows) list.append(resultRow(row, maximum));
    section.append(list);
  }
  if (view.value !== undefined) section.append(valueNode(view.value));
  parent.append(section);
}

/** Mask text entry in diagnostics, too: collapsing a secret is not redaction. */
export function displayInput(title: string, input: unknown): unknown {
  if (!["browser_type", "browser_type_focused"].includes(title)) return input ?? {};
  const args = record(input);
  return { ...args, text: typeof args.text === "string" ? `[${args.text.length} characters hidden]` : args.text };
}
