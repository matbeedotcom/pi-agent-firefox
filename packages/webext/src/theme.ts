/**
 * Browser-theme bridge.
 *
 * The panel pages (Firefox sidebar, Thunderbird Space + message-adjacent pane)
 * are WebExtension HTML documents: they do NOT inherit the browser's XUL
 * chrome styling, so they carry their own CSS palette. To render "with the
 * browser theme" we read the active lightweight theme via browser.theme
 * (Firefox 84+ / Thunderbird 115+; no extra permission) in the background
 * event page — the only context where the API is guaranteed — and ship the
 * snapshot inside the usual pi/state push. applyPiTheme() maps the LWT color
 * keys onto the page's CSS custom properties.
 */

export type PiThemeMode = "light" | "dark";

export interface PiTheme {
  mode: PiThemeMode;
  /** LWT color keys (frame, toolbar, text, accent, ...) as hex/rgb strings. */
  colors: Record<string, string>;
}

/** The LWT fields we consume, with the shape of the API result we need. */
interface ThemeResult {
  mode?: string;
  colors?: Record<string, unknown>;
  /** Thunderbird reports the color scheme here instead of `mode`. */
  properties?: { color_scheme?: unknown };
}

/**
 * Read the active browser theme. Tries the standard `theme.getTheme`
 * (Firefox/Chrome) and the Firefox alias `theme.getCurrent`. Returns
 * undefined when the API is unavailable (we then keep the page's own
 * dark palette) or on any error.
 */
export async function fetchPiTheme(): Promise<PiTheme | undefined> {
  const browserAny: unknown = (globalThis as { browser?: unknown }).browser;
  const api = (browserAny as { theme?: unknown } | undefined)?.theme as
    | { getTheme?: () => Promise<ThemeResult>; getCurrent?: () => Promise<ThemeResult> }
    | undefined;
  const read = api?.getTheme ?? api?.getCurrent;
  if (typeof read !== "function") return undefined;
  try {
    const t = await read.call(api);
    const colors: Record<string, string> = {};
    for (const [key, value] of Object.entries(t.colors ?? {})) {
      if (typeof value === "string" && value.length > 0) colors[key] = value;
    }
    // Firefox reports `mode`; Thunderbird reports properties.color_scheme.
    const cs = t.properties?.color_scheme;
    const mode: PiThemeMode =
      t.mode === "light" || t.mode === "dark" ? t.mode : cs === "light" || cs === "dark" ? cs : "dark";
    return { mode, colors };
  } catch (err) {
    console.warn("[pi-theme] reading the browser theme failed", err);
    return undefined;
  }
}

/**
 * LWT color key -> CSS custom property override. The page stylesheets define
 * dark defaults for these variables; inline overrides on <html> win over
 * them, and removing them restores the defaults. --ok/--warn/--err stay
 * hardcoded (theme APIs have no status colors).
 */
const THEME_VARS: ReadonlyArray<readonly [string, string]> = [
  ["frame", "--bg"],
  ["toolbar", "--bg-2"],
  ["panel", "--bg-3"],
  ["text", "--text"],
  ["icons", "--muted"],
  ["accent", "--accent"],
  ["accent_text", "--accent-text"],
  ["field", "--field"],
  ["field_text", "--field-text"],
  ["border_normal", "--border"],
];

/**
 * Apply a theme snapshot to the current document (panel pages only — call
 * fetchPiTheme in the background). A theme with no colors (API unavailable)
 * simply clears any previous overrides, falling back to the page palette.
 */
let lastAppliedKey = "";

export function applyPiTheme(theme: PiTheme | undefined): void {
  // Called on every state push; re-apply only when the snapshot changed.
  const key = theme ? JSON.stringify(theme) : "";
  if (key === lastAppliedKey) return;
  lastAppliedKey = key;
  const root = document.documentElement;
  if (theme) {
    root.dataset.piTheme = theme.mode;
  } else {
    delete root.dataset.piTheme;
  }
  for (const [colorKey, cssVar] of THEME_VARS) {
    const value = theme?.colors[colorKey];
    if (typeof value === "string" && value.length > 0) {
      root.style.setProperty(cssVar, value);
    } else {
      root.style.removeProperty(cssVar);
    }
  }
}
