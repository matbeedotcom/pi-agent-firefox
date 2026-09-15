/**
 * Markdown rendering for the chat panes, built on the `streaming-markdown`
 * package (https://github.com/thetarnav/streaming-markdown).
 *
 * The panes stream ACP text chunks, so rendering is incremental: each
 * transcript block owns one parser, and `parser_write` only appends new DOM
 * nodes — it never rewrites existing ones. That keeps already-streamed text
 * selectable mid-stream and means finished blocks are never re-rendered.
 */
import * as smd from "streaming-markdown";

/**
 * Render a complete markdown `text` into `target` in one shot (write + end).
 * The target is cleared of any parser output first, so it is safe to reuse.
 */
export function renderMarkdownInto(target: HTMLElement, text: string): void {
  const parser = smd.parser(smd.default_renderer(target));
  if (text) smd.parser_write(parser, text);
  smd.parser_end(parser);
}

/**
 * Incremental markdown view for one transcript block. `write()` appends a
 * chunk of markdown text to the live DOM; `end()` flushes any pending tokens
 * (e.g. an unclosed `**bold**` at the end of a stream) and finalizes the view.
 * The view is created on `parent` with a `div.md` wrapper.
 */
export class MarkdownView {
  /** The `div.md` wrapper the markdown is rendered into. */
  readonly el: HTMLElement;
  private parser: smd.Parser;
  private ended = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "md";
    parent.append(this.el);
    this.parser = smd.parser(smd.default_renderer(this.el));
  }

  /** Append a new chunk of markdown text. No-op after `end()`. */
  write(chunk: string): void {
    if (!this.ended && chunk) smd.parser_write(this.parser, chunk);
  }

  /** Flush pending tokens and mark the view final (further `write`s are ignored). */
  end(): void {
    if (this.ended) return;
    smd.parser_end(this.parser);
    this.ended = true;
  }
}
