// ============================================================
// P1.3 — guard: the dead completenessReviewer path is GONE
// ============================================================
// `reviewCompleteness` was dead code: its envelope extractor read
// `inv.result`, a field the current ToolInvocation does NOT carry, so
// it always returned {} → always passed. The v2 route still called it
// every turn and mapped a FAIL to an `"incompleteness"` validator
// violation that could never fire. P1.3 removes the whole path.
//
// This guard pins the removal so a future executor cannot silently
// re-wire it:
//   • the live v2 route source contains NEITHER `reviewCompleteness`
//     NOR the `"incompleteness"` violation literal;
//   • the engine no longer publicly exports `reviewCompleteness`.
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as engine from "@nyupath/engine";

describe("completenessReviewer removal (P1.3)", () => {
    it("the v2 route source references neither reviewCompleteness nor the incompleteness kind", () => {
        const routeSrc = readFileSync(
            join(__dirname, "../app/api/chat/v2/route.ts"),
            "utf8",
        );
        expect(routeSrc).not.toContain("reviewCompleteness");
        expect(routeSrc).not.toContain("incompleteness");
    });

    it("the engine package no longer exports reviewCompleteness", () => {
        expect((engine as Record<string, unknown>).reviewCompleteness).toBeUndefined();
    });
});
