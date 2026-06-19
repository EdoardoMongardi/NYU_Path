// ============================================================
// whatIfAuditUploadOffer.test.ts — H4.2b-1 engine marker tests
// ============================================================
// Verifies that what_if_audit emits the Branch-A upload-offer
// marker (offerAuditUpload + hypotheticalProgramLabel) and the
// machine-extractable AUDIT_UPLOAD_OFFER summary line, while
// keeping extractVerbatim / disclaimer / outputMode untouched.
// ============================================================

import { describe, expect, it } from "vitest";
import {
    whatIfAuditTool,
    prettifyProgramId,
    buildProgramLabel,
} from "../../src/agent/tools/whatIfAudit.js";
import { mkDpr } from "../helpers/mkDpr.js";
import type { ToolSession } from "../../src/agent/tool.js";

const ABORT = new AbortController().signal;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dprSession(): ToolSession {
    return {
        student: {
            id: "test_student",
            catalogYear: "2024-2025",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
        },
        degreeProgressReport: mkDpr(),
    };
}

function emptySession(): ToolSession {
    return {};
}

// ---------------------------------------------------------------------------
// prettifyProgramId — pure unit tests
// ---------------------------------------------------------------------------

describe("prettifyProgramId — pure prettifier", () => {
    it("converts economics_ba → 'Economics BA'", () => {
        expect(prettifyProgramId("economics_ba")).toBe("Economics BA");
    });

    it("converts mathematics_minor → 'Mathematics Minor'", () => {
        expect(prettifyProgramId("mathematics_minor")).toBe("Mathematics Minor");
    });

    it("converts stern_finance_bs → 'Stern Finance BS'", () => {
        expect(prettifyProgramId("stern_finance_bs")).toBe("Stern Finance BS");
    });

    it("converts a single-word id → Title-Cased", () => {
        expect(prettifyProgramId("economics")).toBe("Economics");
    });
});

// ---------------------------------------------------------------------------
// buildProgramLabel — pure unit tests
// ---------------------------------------------------------------------------

describe("buildProgramLabel — array → joined label", () => {
    it("single id → single label", () => {
        expect(buildProgramLabel(["economics_ba"])).toBe("Economics BA");
    });

    it("two ids → comma-separated labels", () => {
        expect(buildProgramLabel(["economics_ba", "mathematics_minor"])).toBe(
            "Economics BA, Mathematics Minor",
        );
    });

    it("three ids → comma-separated labels", () => {
        expect(buildProgramLabel(["stern_finance_bs", "economics_ba", "mathematics_minor"])).toBe(
            "Stern Finance BS, Economics BA, Mathematics Minor",
        );
    });

    it("is deterministic on repeated call", () => {
        const ids = ["economics_ba", "mathematics_minor"];
        expect(buildProgramLabel(ids)).toBe(buildProgramLabel(ids));
    });
});

// ---------------------------------------------------------------------------
// call(...) — offerAuditUpload + hypotheticalProgramLabel
// ---------------------------------------------------------------------------

describe("what_if_audit call — upload offer fields", () => {
    it("returns offerAuditUpload === true with a DPR session", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["economics_ba"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        expect(out.offerAuditUpload).toBe(true);
    });

    it("returns correct hypotheticalProgramLabel for a single id", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["economics_ba"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        expect(out.hypotheticalProgramLabel).toBe("Economics BA");
    });

    it("returns correct hypotheticalProgramLabel for multiple ids", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["economics_ba", "mathematics_minor"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        expect(out.hypotheticalProgramLabel).toBe("Economics BA, Mathematics Minor");
    });

    it("returns offerAuditUpload === true with no DPR in session", async () => {
        // The no-DPR path returns guidance without a DPR; the upload offer
        // is still emitted (the branch-A path is always surfaced).
        const session = emptySession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["stern_finance_bs"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        expect(out.offerAuditUpload).toBe(true);
        expect(out.hypotheticalProgramLabel).toBe("Stern Finance BS");
    });
});

// ---------------------------------------------------------------------------
// summarizeResult — AUDIT_UPLOAD_OFFER line
// ---------------------------------------------------------------------------

describe("what_if_audit summarizeResult — AUDIT_UPLOAD_OFFER line", () => {
    it("includes the exact AUDIT_UPLOAD_OFFER: <label> line for a single id", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["economics_ba"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const summary = whatIfAuditTool.summarizeResult(out);
        expect(summary).toMatch(/^AUDIT_UPLOAD_OFFER: Economics BA$/m);
    });

    it("includes the exact AUDIT_UPLOAD_OFFER: <label> line for multiple ids", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["economics_ba", "mathematics_minor"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const summary = whatIfAuditTool.summarizeResult(out);
        expect(summary).toMatch(/^AUDIT_UPLOAD_OFFER: Economics BA, Mathematics Minor$/m);
    });

    it("still includes the existing WHAT-IF header line", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["stern_finance_bs"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const summary = whatIfAuditTool.summarizeResult(out);
        expect(summary).toMatch(/^WHAT-IF/m);
    });

    it("still includes the REQUIRED DISCLAIMER line", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["stern_finance_bs"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const summary = whatIfAuditTool.summarizeResult(out);
        expect(summary).toMatch(/REQUIRED DISCLAIMER/);
    });
});

// ---------------------------------------------------------------------------
// extractVerbatim — regression guard (disclaimer must be byte-identical)
// ---------------------------------------------------------------------------

describe("what_if_audit extractVerbatim — regression guard", () => {
    it("returns the disclaimer string unchanged", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["stern_finance_bs"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const verbatim = whatIfAuditTool.extractVerbatim?.(out);
        // Must match the known DISCLAIMER text byte-for-byte
        expect(verbatim).toBe(
            "This estimate is based on AI-extracted requirements from NYU's bulletin. " +
            "Verify with an academic adviser before applying for an internal transfer or program change.",
        );
    });

    it("extractVerbatim equals result.disclaimer (no transformation)", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["economics_ba"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const verbatim = whatIfAuditTool.extractVerbatim?.(out);
        expect(verbatim).toBe(out.disclaimer);
    });
});

// ---------------------------------------------------------------------------
// outputMode guard
// ---------------------------------------------------------------------------

describe("what_if_audit tool metadata", () => {
    it("outputMode is semi_hardened (not changed)", () => {
        expect(whatIfAuditTool.outputMode).toBe("semi_hardened");
    });
});
