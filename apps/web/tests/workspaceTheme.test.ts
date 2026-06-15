// ============================================================
// Phase 4 Task E2.3 — NYU-violet light/dark theme pass (workspace shell)
// ============================================================
// `apps/web` ships no DOM render harness (vitest = node), so this guard
// reads the two CSS files as TEXT and asserts the styling contract that
// E2.3 establishes, the same static-content approach used by
// completenessReviewerRemoved.test.ts:
//
//   1. The plan-badge state classes (.planBadge*) and the slot-state
//      glyph (.slotLockIcon) carry NO hardcoded hex literal — every
//      colour is a `var(--…)` token. (E2.1 left literal hex like
//      `#d1e7dd` / `#842029` in those classes; E2.3 converts them.)
//   2. At least one workspace surface in those classes references an
//      `--nyu-violet*` brand variable (the brand is applied, not just
//      neutralised).
//   3. globals.css defines the new `--badge-*` semantic tokens in
//      `:root` (light), and a `[data-theme="dark"]` block redefines the
//      `--badge-*` AND the neutral (`--bg-*` / `--text-*`) tokens so a
//      dark variant resolves. The light `:root` values are unchanged
//      (this test does not assert the literal light values, only that
//      the dark override layer exists).
//
// RED-then-GREEN: against the pre-E2.3 CSS (hardcoded hex, no dark
// block) assertions (1) and (3) FAIL; after the E2.3 pass all pass.
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const chatCss = readFileSync(
    join(__dirname, "../app/chat/chat.module.css"),
    "utf8",
);
const globalsCss = readFileSync(
    join(__dirname, "../app/globals.css"),
    "utf8",
);

// A hex colour literal: #rgb, #rrggbb, #rgba, #rrggbbaa. Anchored on a
// `#` that is NOT part of a longer word so we don't match e.g. an id
// selector `#foo` (there are none in these files anyway).
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Extract the bodies (the text between `{` and `}`) of every rule whose
 * selector list contains one of the given class names. Robust to a
 * selector that lists several classes and to nested commas; we walk the
 * stylesheet rule-by-rule on the top-level brace structure rather than
 * trusting a single greedy regex. Comments are stripped first so a hex
 * sitting in a `/* … *​/` note can never cause a false failure.
 */
function ruleBodiesFor(css: string, classNames: string[]): string[] {
    // Strip /* … */ comments (these CSS files have no string literals
    // that could contain `/*`, so a plain global strip is safe).
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const bodies: string[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(noComments)) !== null) {
        const selector = m[1];
        const body = m[2];
        if (classNames.some((c) => selector.includes(`.${c}`))) {
            bodies.push(body);
        }
    }
    return bodies;
}

const BADGE_CLASSES = [
    "planBadgeRow",
    "planBadgeValid",
    "planBadgeInvalid",
    "planBadgeGrounded",
    "planBadgeHedged",
    "planBadgeNeutral",
];

describe("E2.3 — workspace badge/slot surfaces use CSS variables (no hardcoded hex)", () => {
    it("extracts the expected number of badge + slot rule blocks", () => {
        // Sanity: the extractor actually found the surfaces (so a green
        // result can't be a vacuous 'no blocks → no hex' pass).
        const badgeBodies = ruleBodiesFor(chatCss, BADGE_CLASSES);
        const slotBodies = ruleBodiesFor(chatCss, ["slotLockIcon"]);
        expect(badgeBodies.length).toBeGreaterThanOrEqual(5);
        expect(slotBodies.length).toBeGreaterThanOrEqual(1);
    });

    it("no .planBadge* rule body contains a hardcoded hex literal", () => {
        const bodies = ruleBodiesFor(chatCss, BADGE_CLASSES);
        for (const body of bodies) {
            const hex = body.match(HEX_LITERAL);
            expect(hex, `unexpected hardcoded hex in .planBadge* rule: ${hex?.join(", ")}`).toBeNull();
        }
    });

    it("the .slotLockIcon glyph rule body contains no hardcoded hex literal", () => {
        const bodies = ruleBodiesFor(chatCss, ["slotLockIcon"]);
        for (const body of bodies) {
            expect(body.match(HEX_LITERAL)).toBeNull();
        }
    });

    it("the badge/slot surfaces reference var(--…) tokens", () => {
        const bodies = [
            ...ruleBodiesFor(chatCss, BADGE_CLASSES),
            ...ruleBodiesFor(chatCss, ["slotLockIcon"]),
        ].join("\n");
        expect(bodies).toMatch(/var\(--[a-z-]+/);
    });
});

describe("E2.3 — NYU violet applied to a workspace surface", () => {
    it("at least one badge/slot surface references an --nyu-violet* brand variable", () => {
        const bodies = [
            ...ruleBodiesFor(chatCss, BADGE_CLASSES),
            ...ruleBodiesFor(chatCss, ["slotLockIcon"]),
        ].join("\n");
        expect(bodies).toMatch(/var\(--nyu-violet[a-z-]*/);
    });
});

describe("E2.3 — globals.css defines --badge-* tokens with a working dark theme", () => {
    const noComments = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");

    it(":root defines the new --badge-* semantic tokens (light values)", () => {
        const root = noComments.match(/:root\s*\{([\s\S]*?)\}/);
        expect(root, ":root block must exist").not.toBeNull();
        const rootBody = root![1];
        expect(rootBody).toMatch(/--badge-valid-/);
        expect(rootBody).toMatch(/--badge-invalid-/);
        expect(rootBody).toMatch(/--badge-hedged-/);
        expect(rootBody).toMatch(/--badge-neutral-/);
    });

    it("a [data-theme=\"dark\"] block exists", () => {
        expect(noComments).toMatch(/\[data-theme=["']dark["']\]\s*\{/);
    });

    it("the dark block redefines the --badge-* tokens AND the neutral tokens", () => {
        const dark = noComments.match(/\[data-theme=["']dark["']\]\s*\{([\s\S]*?)\}/);
        expect(dark, "[data-theme=\"dark\"] block must exist").not.toBeNull();
        const darkBody = dark![1];
        // badge tokens overridden for dark
        expect(darkBody).toMatch(/--badge-valid-/);
        expect(darkBody).toMatch(/--badge-invalid-/);
        expect(darkBody).toMatch(/--badge-hedged-/);
        expect(darkBody).toMatch(/--badge-neutral-/);
        // neutral tokens overridden for dark (so the workspace resolves)
        expect(darkBody).toMatch(/--bg-primary\s*:/);
        expect(darkBody).toMatch(/--text-primary\s*:/);
        expect(darkBody).toMatch(/--border-light\s*:/);
    });

    it("the NYU-violet brand variable name is kept (brand preserved in dark)", () => {
        const dark = noComments.match(/\[data-theme=["']dark["']\]\s*\{([\s\S]*?)\}/);
        // The dark block need not redefine --nyu-violet, but the brand
        // token must still exist app-wide (defined in :root).
        const root = noComments.match(/:root\s*\{([\s\S]*?)\}/);
        expect(root![1]).toMatch(/--nyu-violet\s*:/);
        expect(dark).not.toBeNull();
    });
});
