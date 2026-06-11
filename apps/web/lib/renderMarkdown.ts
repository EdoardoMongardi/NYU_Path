/**
 * Render a small markdown subset (bold / italic / inline-code / newlines) to
 * an HTML string for injection via `dangerouslySetInnerHTML`.
 *
 * SECURITY: the input may be untrusted (LLM output, restored DB transcripts,
 * raw user messages). We therefore HTML-escape the entities `&`, `<`, `>`
 * FIRST, then apply the markdown transforms. Because the `<strong>` / `<em>` /
 * `<code>` / `<br />` tags are inserted AFTER the escape step, they are emitted
 * as live HTML and survive, while any markup in the original text is rendered
 * inert (e.g. `<img onerror=...>` → `&lt;img onerror=...&gt;`).
 *
 * Order matters twice over: `&` must be escaped before `<`/`>` (otherwise the
 * `&` we introduce gets re-escaped), and escaping must precede the markdown
 * replaces (otherwise it would mangle the tags this function deliberately
 * emits).
 */
// NOTE: this escapes for ELEMENT-CONTENT context only (the markdown output is
// injected as element children). It does NOT escape `"`/`'`, so it is NOT safe
// to reuse for interpolating into an HTML attribute value — doing so would
// reopen an injection hole. Keep this function's use confined to renderMarkdown.
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function renderMarkdown(text: string): string {
    return escapeHtml(text)
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.*?)\*/g, "<em>$1</em>")
        .replace(/`(.*?)`/g, "<code>$1</code>")
        .replace(/\n/g, "<br />");
}
