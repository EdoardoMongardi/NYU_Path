// ============================================================
// F2 — updateProfile DPR-derived field hard guard (defense-in-depth)
// ============================================================
// Owner decision #1 (Docs/plans/34-2026-06-16-phase4-pre-merge-followups.md):
// catalogYear + declaredPrograms come from the student's DPR and CANNOT
// be changed by an agent tool call — to change them the student uploads
// a corrected/new DPR. This is a defense-in-depth backstop to CORE RULE
// 14 + the web-route gate: even if the model tries to stage such a
// change, the tool refuses with a re-upload message.
//
// Scope of the guard (per the plan): catalogYear + declaredPrograms.
// homeSchool keeps its "unknown" web-layer exception (route gate +
// CORE RULE own it); visaStatus stays allowed (never on a DPR).
//
// The guard only fires when a DPR is loaded into the session
// (session.degreeProgressReport set) — session.student's catalogYear /
// declaredPrograms then ARE the DPR-derived values, so a proposed value
// that differs is an attempt to override a DPR-derived field.
// ============================================================

import { describe, expect, it } from "vitest";
import { updateProfileTool } from "../../src/agent/index.js";
import type { ToolSession } from "../../src/agent/index.js";
import type { DegreeProgressReport } from "../../src/index.js";

const ctx = (session: ToolSession) => ({
    signal: new AbortController().signal,
    session,
});

/** A session whose student fields came from a loaded DPR. */
function sessionWithDpr(): ToolSession {
    return {
        student: {
            id: "u1",
            catalogYear: "2024-2025",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
            coursesTaken: [],
            visaStatus: "domestic",
        },
        // A DPR is loaded — the student fields above are DPR-derived.
        degreeProgressReport: {} as DegreeProgressReport,
    };
}

describe("update_profile — DPR-derived field guard (F2)", () => {
    it("REFUSES a catalogYear change when a DPR is loaded, with a re-upload message", async () => {
        const session = sessionWithDpr();
        const result = await updateProfileTool.validateInput!(
            { field: "catalogYear", value: "2026-2027" },
            ctx(session),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/catalog year/i);
        expect(result.userMessage).toMatch(/upload (a )?(corrected|new) DPR/i);
    });

    it("REFUSES a declaredPrograms change when a DPR is loaded, with a re-upload message", async () => {
        const session = sessionWithDpr();
        const result = await updateProfileTool.validateInput!(
            {
                field: "declaredPrograms",
                value: [{ programId: "econ_major_ba", programType: "major" }],
            },
            ctx(session),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/declared (major|minor|program)/i);
        expect(result.userMessage).toMatch(/upload (a )?(corrected|new) DPR/i);
    });

    it("ALLOWS a visaStatus change (never on a DPR) even with a DPR loaded", async () => {
        const session = sessionWithDpr();
        const result = await updateProfileTool.validateInput!(
            { field: "visaStatus", value: "f1" },
            ctx(session),
        );
        expect(result.ok).toBe(true);
    });

    it("does NOT refuse an IDENTICAL catalogYear (no change → nothing to override)", async () => {
        const session = sessionWithDpr();
        const result = await updateProfileTool.validateInput!(
            { field: "catalogYear", value: "2024-2025" }, // same as the DPR-derived value
            ctx(session),
        );
        expect(result.ok).toBe(true);
    });

    it("does NOT fire the guard when NO DPR is loaded (legacy in-memory path preserved)", async () => {
        const session: ToolSession = {
            student: {
                id: "u1",
                catalogYear: "2024-2025",
                homeSchool: "cas",
                declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
                coursesTaken: [],
                visaStatus: "domestic",
            },
            // No degreeProgressReport — the catalogYear isn't DPR-anchored here.
        };
        const result = await updateProfileTool.validateInput!(
            { field: "catalogYear", value: "2026-2027" },
            ctx(session),
        );
        expect(result.ok).toBe(true);
    });
});
