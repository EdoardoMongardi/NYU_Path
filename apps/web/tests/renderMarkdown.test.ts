import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../lib/renderMarkdown";

describe("renderMarkdown", () => {
    it("escapes a dangerous HTML tag while still rendering the markdown", () => {
        const out = renderMarkdown("<img src=x onerror=alert(1)>**bold**");
        // The dangerous tag must be neutralized into escaped entities.
        expect(out).toContain("&lt;img");
        expect(out).toContain("&gt;");
        // No raw <img anywhere — that is the XSS vector.
        expect(out).not.toContain("<img");
        // The markdown the function deliberately emits must survive.
        expect(out).toContain("<strong>bold</strong>");
    });

    it("escapes ampersands and angle brackets without double-escaping", () => {
        // & must be escaped first (-> &amp;), then < and >.
        expect(renderMarkdown("Tom & Jerry")).toBe("Tom &amp; Jerry");
        // Mixed: both the < and the & are escaped exactly once each.
        expect(renderMarkdown("5 < 3 & true")).toBe("5 &lt; 3 &amp; true");
        // A pre-existing entity-looking sequence is treated as literal text:
        // the leading & is escaped, so &lt; in the INPUT becomes &amp;lt;.
        expect(renderMarkdown("&lt;")).toBe("&amp;lt;");
    });

    it("still renders plain markdown (bold / italic / code)", () => {
        expect(renderMarkdown("**bold** *em* `code`")).toBe(
            "<strong>bold</strong> <em>em</em> <code>code</code>",
        );
    });

    it("converts newlines to <br /> tags", () => {
        expect(renderMarkdown("line1\nline2")).toBe("line1<br />line2");
    });

    it("returns an empty string unchanged", () => {
        expect(renderMarkdown("")).toBe("");
    });
});
