// Shared by the live probe and its regression tests; no browser side effects.
export function screenshotImage(part) {
  if (part?.type !== "image" || typeof part.data !== "string") return undefined;
  const data = Buffer.from(part.data, "base64");
  const png = data.length > 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data.length > 4 && data[0] === 255 && data[1] === 216 && data[2] === 255 && data.at(-2) === 255 && data.at(-1) === 217;
  if (png) return { data, extension: "png" };
  if (jpeg) return { data, extension: "jpg" };
  return undefined;
}

export function checkpointButtonRef(checkpoint) {
  return [checkpoint?.ref, checkpoint?.buttonRef, checkpoint?.button_ref, checkpoint?.elRef]
    .find((ref) => typeof ref === "string" && ref.startsWith("el-") && ref.length > 3);
}

// Shape only: page visits and factual support require transcript review.
export function recipeEntriesValid(checkpoint) {
  const entries = Array.isArray(checkpoint) ? checkpoint : checkpoint?.recipes;
  return Array.isArray(entries) && entries.length === 3 &&
    entries.every(e => e && typeof e.name === "string" && e.name.trim() &&
      typeof e.description === "string" && e.description.trim() &&
      typeof e.url === "string" && /^https?:\/\//.test(e.url)) &&
    new Set(entries.map(e => e.url)).size === 3;
}
