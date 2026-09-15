import { activityLabel, activityStatus, resultParts, targetPreview, type BrowserActivity, type ToolImage } from "./tool-activity.js";
import { parseResult, record, resultView } from "./activity-result.js";
import { activityNode as node, appendResultView, displayInput } from "./activity-result-view.js";

export interface ActivityCardData {
  title: string;
  status: string;
  text: string;
  input?: unknown;
  images?: ToolImage[];
  activities?: BrowserActivity[];
}

function addImages(parent: HTMLElement, images: ToolImage[]): void {
  for (const [index, image] of images.entries()) {
    const details = document.createElement("details");
    details.className = "capture";
    const summary = document.createElement("summary");
    const img = document.createElement("img");
    img.src = `data:${image.mimeType};base64,${image.data}`;
    img.alt = `Browser screenshot ${index + 1}`;
    img.loading = "lazy";
    summary.append(img, node("span", "capture-caption", "Screenshot · expand to inspect"));
    details.append(summary, node("p", "capture-caption", "Actual image returned by the tool"));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "capture-open";
    open.textContent = "Inspect full image ⤢";
    const dialog = document.createElement("dialog");
    dialog.className = "capture-dialog";
    dialog.setAttribute("aria-label", "Full resolution screenshot");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close image";
    close.onclick = () => dialog.close();
    const full = document.createElement("img");
    full.src = img.src;
    full.alt = img.alt;
    dialog.append(close, full);
    open.onclick = () => dialog.showModal();
    details.append(open);
    parent.append(details, dialog);
  }
}

function addPreview(parent: HTMLElement, data: ActivityCardData): void {
  if (data.status === "completed") {
    const view = resultView(data.title, data.input, data.text);
    if (view) { appendResultView(parent, view); return; }
  }
  const preview = targetPreview(data.title, data.input, data.text);
  const stage = node("div", `activity-stage ${preview.kind}`);
  stage.append(node("span", "activity-context", ["click", "type"].includes(preview.kind) ? "Element preview · " + preview.detail : activityStatus(data.status)));
  const target = node("div", "activity-target", preview.label);
  const result = record(parseResult(data.text));
  if (preview.kind === "click") target.append(node("span", "click-indicator", data.status === "completed" && result.clicked ? "✓ Clicked" : activityStatus(data.status)));
  if (preview.kind === "type") target.append(node("span", "typing-indicator", "••••••"));
  stage.append(target);
  if (result.submitted === true) stage.append(node("div", "result-caption", "✓ Form submission requested"));
  parent.append(stage);
}

interface TimelineStep {
  details: HTMLDetailsElement;
  summary: HTMLElement;
  card: ReturnType<typeof createActivityCard>;
  revealed: boolean;
}

export function createActivityCard(data: ActivityCardData): { wrap: HTMLElement; update: (next: ActivityCardData) => void } {
  const wrap = node("article", "msg tool activity-card");
  const [icon, label] = activityLabel(data.title);
  const head = node("div", "tool-head");
  const name = node("span", "activity-name", `${icon}  ${label}`);
  const status = node("span", "tool-status");
  status.setAttribute("role", "status");
  head.append(name, status);
  const evidence = node("div", "activity-evidence");
  const preview = node("div", "activity-preview");
  const nested = node("div", "activity-nested");
  const progress = node("div", "nested-heading");
  const captures = node("div", "activity-captures");
  const error = node("p", "activity-error");
  evidence.append(preview, progress, nested, captures, error);
  const children = new Map<string, TimelineStep>();
  const details = document.createElement("details");
  details.className = "activity-details";
  details.append(node("summary", "", "Tool input & returned data"));
  const body = node("div", "activity-output");
  details.append(body);
  wrap.append(head, evidence, details);
  let previewKey = "";
  let imagesKey = "";
  let textKey = "";
  const update = (next: ActivityCardData) => {
    wrap.dataset.status = next.status;
    status.textContent = activityStatus(next.status);
    name.textContent = activityLabel(next.title).join("  ");
    const key = JSON.stringify([next.title, next.status, next.input, next.text, !!next.images?.length, !!next.activities?.length]);
    if (key !== previewKey) {
      previewKey = key;
      preview.replaceChildren();
      if (!next.activities?.length && !next.images?.length) addPreview(preview, next);
    }
    updateChildren(nested, children, next);
    const activities = next.activities ?? [];
    progress.hidden = !activities.length;
    progress.textContent = `${activities.filter((a) => a.status === "completed").length} of ${activities.length} steps completed`;
    const nestedImages = next.activities?.flatMap((a) => resultParts((a.result as { content?: unknown })?.content).images) ?? [];
    const images = (next.images ?? []).filter((img) => !nestedImages.some((other) => other.data === img.data));
    const imageKey = JSON.stringify(images);
    if (imageKey !== imagesKey) {
      imagesKey = imageKey;
      captures.replaceChildren();
      addImages(captures, images);
    }
    error.textContent = next.status === "failed" ? next.text : "";
    error.hidden = !error.textContent;
    const technical = `${next.title}\n${JSON.stringify(next.input ?? {}, null, 2)}\n\n${next.text}`;
    if (technical !== textKey) {
      textKey = technical;
      body.replaceChildren();
      body.append(node("h4", "result-heading", "Tool input"), node("pre", "", `${next.title}\n${JSON.stringify(displayInput(next.title, next.input), null, 2)}`));
      body.append(node("h4", "result-heading", "Returned text"), node("pre", "", next.text));
    }
  };
  update(data);
  return { wrap, update };
}

function updateChildren(parent: HTMLElement, children: Map<string, TimelineStep>, data: ActivityCardData): void {
  for (const activity of data.activities ?? []) {
    const parts = resultParts((activity.result as { content?: unknown })?.content);
    const status = activity.status === "in_progress" && ["failed", "interrupted", "completed"].includes(data.status) ? "interrupted" : activity.status;
    const next = { ...activity, ...parts, status };
    let step = children.get(activity.id);
    if (!step) {
      const details = document.createElement("details");
      details.className = "activity-step";
      const summary = node("summary", "activity-step-summary");
      const card = createActivityCard(next);
      details.append(summary, card.wrap);
      step = { details, summary, card, revealed: false };
      children.set(activity.id, step);
      parent.append(details);
    } else step.card.update(next);
    step.details.dataset.status = status;
    const label = activityLabel(activity.title)[1];
    const target = targetPreview(activity.title, activity.input, parts.text).label;
    step.summary.textContent = `${activityStatus(status)} · ${label}${target === label ? "" : ` · ${target}`}`;
    if (!step.revealed && (parts.images.length > 0 || status === "failed" || status === "interrupted")) {
      step.details.open = true;
      step.revealed = true;
    }
  }
}
