// ============================================================
// intendedMajorPreview (Phase 4 Task E5.5) — undeclared → intended
// major → a HEDGED What-If / RAG-preview, reached via a CHAT-TURN
// injection (NO engine import in the wizard, NO new route, NO new
// requirement-model logic — this WIRES the existing Lane-B / RAG-preview
// substrate from Phase 1/3 into the last wizard step).
// ============================================================
// apps/web ships NO DOM render harness (no @testing-library/react, no
// jsdom — vitest runs in node), so the two pure helpers are extracted
// into `apps/web/lib/wizard/intendedMajor.ts` and unit-tested here.
// The React shell (OnboardingWizard.tsx) is the thin consumer: when the
// parsed profile is UNDECLARED it surfaces an optional intended-major
// input plus two affordances —
//   (a) "Upload a What-If DPR" → the EXISTING `/api/onboard` upload
//       (a What-If report parses end-to-end via `parseDpr`, dropping
//       into Lane A — see packages/engine/tests/foundation/whatIfParse).
//   (b) "Preview by name" → inject `buildIntendedMajorPreviewTurn(...)`
//       through the SAME `addMessage('user', text) → handleSendV2`
//       rail E5.4 uses, so the agent answers through its grounded RAG
//       (`what_if_audit` / `search_policy`) + the D4.4 confidence rail.
//
// THE HEDGE (D4.4 — the binding contract this test guards): the preview
// turn is HONESTLY framed as a PREVIEW to VERIFY WITH THE ADVISER and
// NOT a confirmed/finalized plan, so the engine's §11 confidence +
// "confirm with your adviser" rail (systemPrompt.ts) fires — especially
// for non-CAS / RAG-derived intended majors. The wizard NEVER renders a
// fabricated requirement list (no-invention §11); the grounded agent
// owns the actual requirement content. The framing is school-AGNOSTIC,
// so a non-CAS (NYU Shanghai / Abu Dhabi) intended major stays hedged.
// ============================================================

import { describe, it, expect } from "vitest";
import type { ProgramDeclaration } from "@nyupath/shared";
import {
    isUndeclared,
    buildIntendedMajorPreviewTurn,
} from "../lib/wizard/intendedMajor";

// ---------------------------------------------------------------------------
// isUndeclared — empty / absent declaredPrograms ⇒ undeclared.
// ---------------------------------------------------------------------------

describe("isUndeclared", () => {
    it("an empty declaredPrograms array ⇒ undeclared (true)", () => {
        expect(isUndeclared([])).toBe(true);
    });

    it("undefined declaredPrograms ⇒ undeclared (true)", () => {
        expect(isUndeclared(undefined)).toBe(true);
    });

    it("at least one declared program ⇒ NOT undeclared (false)", () => {
        const declared: ProgramDeclaration[] = [
            { programId: "cs_major_ba", programType: "major" },
        ];
        expect(isUndeclared(declared)).toBe(false);
    });

    it("a declared minor alone still counts as declared (false)", () => {
        const declared: ProgramDeclaration[] = [
            { programId: "mathematics_minor", programType: "minor" },
        ];
        expect(isUndeclared(declared)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// buildIntendedMajorPreviewTurn — VERBATIM major + HEDGED preview framing.
// ---------------------------------------------------------------------------

describe("buildIntendedMajorPreviewTurn — hedged preview framing (D4.4)", () => {
    it("contains the intended major VERBATIM (general compiler, not rewritten)", () => {
        const turn = buildIntendedMajorPreviewTurn("Computer Science");
        expect(turn).toContain("Computer Science");
    });

    it("is tagged as a PREVIEW", () => {
        const turn = buildIntendedMajorPreviewTurn("Computer Science");
        expect(/preview/i.test(turn)).toBe(true);
    });

    it("tells the student to VERIFY/CONFIRM with their ADVISER (the §11 rail)", () => {
        const turn = buildIntendedMajorPreviewTurn("Computer Science");
        // verify OR confirm …
        expect(/verify|confirm/i.test(turn)).toBe(true);
        // … with the adviser/advisor.
        expect(/advis[eo]r/i.test(turn)).toBe(true);
    });

    it("signals it is NOT a confirmed / finalized / unqualified plan", () => {
        const turn = buildIntendedMajorPreviewTurn("Computer Science");
        expect(/not a (?:confirmed|finalized|final|complete)/i.test(turn)).toBe(true);
    });

    it("asks the agent to attach its confidence (the D4.4 confidence level)", () => {
        const turn = buildIntendedMajorPreviewTurn("Computer Science");
        expect(/confidence/i.test(turn)).toBe(true);
    });

    it("does NOT present itself as a finalized / confirmed degree plan", () => {
        const turn = buildIntendedMajorPreviewTurn("Computer Science");
        // The turn must NOT assert it IS a confirmed/final plan (it must
        // explicitly disclaim being one). Guard against an accidental
        // unqualified-plan phrasing.
        expect(/this is (?:a|your) (?:confirmed|final|finalized) (?:degree )?plan/i.test(turn)).toBe(
            false,
        );
    });
});

// ---------------------------------------------------------------------------
// School-agnostic hedge — a non-CAS (NYU Shanghai / Abu Dhabi) intended
// major MUST stay hedged. The D4.4 non-CAS hedge especially must hold,
// and the framing must carry the major VERBATIM regardless of school.
// ---------------------------------------------------------------------------

describe("buildIntendedMajorPreviewTurn — non-CAS stays hedged (school-agnostic)", () => {
    const NON_CAS_MAJORS = [
        "Interactive Media Arts", // NYU Shanghai
        "Social Research and Public Policy", // NYU Abu Dhabi
        "Business and Finance", // NYU Shanghai
    ];

    for (const major of NON_CAS_MAJORS) {
        it(`"${major}" (non-CAS) → carried VERBATIM AND hedged as a preview-to-verify`, () => {
            const turn = buildIntendedMajorPreviewTurn(major);
            // Verbatim major (the general compiler handles ANY school's
            // major — the wizard invents nothing).
            expect(turn).toContain(major);
            // Hedged: preview …
            expect(/preview/i.test(turn)).toBe(true);
            // … verify/confirm with adviser …
            expect(/verify|confirm/i.test(turn)).toBe(true);
            expect(/advis[eo]r/i.test(turn)).toBe(true);
            // … NOT a confirmed plan …
            expect(/not a (?:confirmed|finalized|final|complete)/i.test(turn)).toBe(true);
            // … and attach confidence.
            expect(/confidence/i.test(turn)).toBe(true);
        });
    }
});
