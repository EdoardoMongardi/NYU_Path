import { describe, it, expect } from "vitest";
import { visaValidator, type VisaInputContext } from "../../src/dpr/visaValidator";

function makeCtx(overrides: Partial<VisaInputContext> = {}): VisaInputContext {
    return {
        termCredits: 16,
        term: "2026-fall",
        profile: { visaStatus: "domestic" },
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        f1OnlineCreditsPerTermCap: 3,
        ...overrides,
    };
}

// ---- fullTimeSatisfied ----

describe("visaValidator — fullTimeSatisfied", () => {
    it("F-1 at floor → pass (verifiedFrom DPR)", () => {
        const r = visaValidator(makeCtx({ termCredits: 12, profile: { visaStatus: "f1" } }));
        expect(r.fullTimeSatisfied.status).toBe("pass");
        if (r.fullTimeSatisfied.status === "pass") {
            expect(r.fullTimeSatisfied.verifiedFrom).toBe("DPR");
        }
    });

    it("F-1 above floor → pass", () => {
        const r = visaValidator(makeCtx({ termCredits: 16, profile: { visaStatus: "f1" } }));
        expect(r.fullTimeSatisfied.status).toBe("pass");
    });

    it("F-1 below floor without RCL → fail", () => {
        const r = visaValidator(makeCtx({ termCredits: 10, profile: { visaStatus: "f1" } }));
        expect(r.fullTimeSatisfied.status).toBe("fail");
        if (r.fullTimeSatisfied.status === "fail") {
            expect(r.fullTimeSatisfied.reason).toMatch(/F-1.*10.*12/);
        }
    });

    it("F-1 below floor WITH RCL → pass via student-input", () => {
        const r = visaValidator(makeCtx({ termCredits: 10, profile: { visaStatus: "f1", rclApproved: true } }));
        expect(r.fullTimeSatisfied.status).toBe("pass");
        if (r.fullTimeSatisfied.status === "pass") {
            expect(r.fullTimeSatisfied.verifiedFrom).toBe("student-input");
        }
    });

    it("domestic at or above floor → pass (verifiedFrom DPR)", () => {
        const r = visaValidator(makeCtx({ termCredits: 12, profile: { visaStatus: "domestic" } }));
        expect(r.fullTimeSatisfied.status).toBe("pass");
        if (r.fullTimeSatisfied.status === "pass") {
            expect(r.fullTimeSatisfied.verifiedFrom).toBe("DPR");
        }
    });

    it("domestic below floor with allowBelowF1Floor → pass via student-input", () => {
        const r = visaValidator(makeCtx({ termCredits: 9, profile: { visaStatus: "domestic", allowBelowF1Floor: true } }));
        expect(r.fullTimeSatisfied.status).toBe("pass");
        if (r.fullTimeSatisfied.status === "pass") {
            expect(r.fullTimeSatisfied.verifiedFrom).toBe("student-input");
        }
    });

    it("domestic below floor without opt-in → fail", () => {
        const r = visaValidator(makeCtx({ termCredits: 9, profile: { visaStatus: "domestic" } }));
        expect(r.fullTimeSatisfied.status).toBe("fail");
        if (r.fullTimeSatisfied.status === "fail") {
            expect(r.fullTimeSatisfied.reason).toMatch(/Domestic.*12/);
        }
    });
});

// ---- creditMinimumSatisfied ----

describe("visaValidator — creditMinimumSatisfied", () => {
    it("at the domestic part-time floor → pass", () => {
        const r = visaValidator(makeCtx({ termCredits: 8, profile: { visaStatus: "domestic" } }));
        expect(r.creditMinimumSatisfied.status).toBe("pass");
    });

    it("below the domestic part-time floor → fail", () => {
        const r = visaValidator(makeCtx({ termCredits: 4, profile: { visaStatus: "domestic" } }));
        expect(r.creditMinimumSatisfied.status).toBe("fail");
        if (r.creditMinimumSatisfied.status === "fail") {
            expect(r.creditMinimumSatisfied.reason).toMatch(/Below.*8.*minimum/);
        }
    });

    it("F-1 at 12 (above part-time floor) → pass", () => {
        const r = visaValidator(makeCtx({ termCredits: 12, profile: { visaStatus: "f1" } }));
        expect(r.creditMinimumSatisfied.status).toBe("pass");
    });

    it("below minimum with null domesticPartTimeFloor falls back to f1Floor", () => {
        const r = visaValidator(makeCtx({ termCredits: 4, profile: { visaStatus: "domestic" }, domesticPartTimeFloor: null }));
        expect(r.creditMinimumSatisfied.status).toBe("fail");
        if (r.creditMinimumSatisfied.status === "fail") {
            // fallback floor is f1Floor=12
            expect(r.creditMinimumSatisfied.reason).toMatch(/Below.*12.*minimum/);
        }
    });
});

// ---- rclEligible ----

describe("visaValidator — rclEligible", () => {
    it("F-1 below floor without RCL → requires-approval (OGS)", () => {
        const r = visaValidator(makeCtx({ termCredits: 10, profile: { visaStatus: "f1" } }));
        expect(r.rclEligible.status).toBe("requires-approval");
        if (r.rclEligible.status === "requires-approval") {
            expect(r.rclEligible.authority).toBe("OGS");
        }
    });

    it("F-1 below floor WITH RCL → pass (student-input)", () => {
        const r = visaValidator(makeCtx({ termCredits: 10, profile: { visaStatus: "f1", rclApproved: true } }));
        expect(r.rclEligible.status).toBe("pass");
        if (r.rclEligible.status === "pass") {
            expect(r.rclEligible.verifiedFrom).toBe("student-input");
        }
    });

    it("F-1 at or above floor → pass (no RCL needed)", () => {
        const r = visaValidator(makeCtx({ termCredits: 12, profile: { visaStatus: "f1" } }));
        expect(r.rclEligible.status).toBe("pass");
        if (r.rclEligible.status === "pass") {
            expect(r.rclEligible.verifiedFrom).toBe("DPR");
        }
    });

    it("non-F-1 → pass (RCL N/A)", () => {
        const r = visaValidator(makeCtx({ termCredits: 6, profile: { visaStatus: "domestic" } }));
        expect(r.rclEligible.status).toBe("pass");
        if (r.rclEligible.status === "pass") {
            expect(r.rclEligible.verifiedFrom).toBe("DPR");
        }
    });
});

// ---- cptConflict ----

describe("visaValidator — cptConflict", () => {
    it("F-1 enrolled in CPT → requires-approval (OGS)", () => {
        const r = visaValidator(makeCtx({ profile: { visaStatus: "f1", cptEnrolled: true } }));
        expect(r.cptConflict.status).toBe("requires-approval");
        if (r.cptConflict.status === "requires-approval") {
            expect(r.cptConflict.authority).toBe("OGS");
        }
    });

    it("F-1 not in CPT → pass", () => {
        const r = visaValidator(makeCtx({ profile: { visaStatus: "f1" } }));
        expect(r.cptConflict.status).toBe("pass");
    });

    it("domestic enrolled in CPT → pass (CPT only applies to F-1)", () => {
        const r = visaValidator(makeCtx({ profile: { visaStatus: "domestic", cptEnrolled: true } }));
        expect(r.cptConflict.status).toBe("pass");
    });
});

// ---- finalTermExceptionPossible ----

describe("visaValidator — finalTermExceptionPossible", () => {
    it("F-1 final term below floor with exception opted in → requires-approval (registrar)", () => {
        const r = visaValidator(makeCtx({
            termCredits: 6,
            profile: { visaStatus: "f1", isFinalTerm: true, finalTermException: true },
        }));
        expect(r.finalTermExceptionPossible.status).toBe("requires-approval");
        if (r.finalTermExceptionPossible.status === "requires-approval") {
            expect(r.finalTermExceptionPossible.authority).toBe("registrar");
        }
    });

    it("F-1 final term below floor WITHOUT exception → fail", () => {
        const r = visaValidator(makeCtx({
            termCredits: 6,
            profile: { visaStatus: "f1", isFinalTerm: true },
        }));
        expect(r.finalTermExceptionPossible.status).toBe("fail");
        if (r.finalTermExceptionPossible.status === "fail") {
            expect(r.finalTermExceptionPossible.reason).toMatch(/final-term.*12/i);
        }
    });

    it("F-1 final term AT floor → pass (no exception needed)", () => {
        const r = visaValidator(makeCtx({
            termCredits: 12,
            profile: { visaStatus: "f1", isFinalTerm: true },
        }));
        expect(r.finalTermExceptionPossible.status).toBe("pass");
    });

    it("F-1 non-final term below floor → pass on this axis (not final term)", () => {
        const r = visaValidator(makeCtx({
            termCredits: 6,
            profile: { visaStatus: "f1", isFinalTerm: false },
        }));
        expect(r.finalTermExceptionPossible.status).toBe("pass");
    });

    it("domestic final term below floor → pass (final-term exception is F-1 only)", () => {
        const r = visaValidator(makeCtx({
            termCredits: 6,
            profile: { visaStatus: "domestic", isFinalTerm: true },
        }));
        expect(r.finalTermExceptionPossible.status).toBe("pass");
    });
});

// ---- onlineLimitSatisfied / inPersonMinimumSatisfied (PRE-PHASE-15) ----

describe("visaValidator — onlineLimitSatisfied / inPersonMinimumSatisfied (PRE-PHASE-15)", () => {
    it("always assumed-pass pre-Phase-15 (domestic baseline)", () => {
        const r = visaValidator(makeCtx());
        expect(r.onlineLimitSatisfied.status).toBe("assumed-pass");
        expect(r.inPersonMinimumSatisfied.status).toBe("assumed-pass");
        if (r.onlineLimitSatisfied.status === "assumed-pass") {
            expect(r.onlineLimitSatisfied.whatWouldFlipIt).toMatch(/online/i);
        }
        if (r.inPersonMinimumSatisfied.status === "assumed-pass") {
            expect(r.inPersonMinimumSatisfied.whatWouldFlipIt).toMatch(/online/i);
        }
    });

    it("always assumed-pass pre-Phase-15 (F-1 full-credit)", () => {
        const r = visaValidator(makeCtx({ termCredits: 12, profile: { visaStatus: "f1" } }));
        expect(r.onlineLimitSatisfied.status).toBe("assumed-pass");
        expect(r.inPersonMinimumSatisfied.status).toBe("assumed-pass");
    });

    it("whatWouldFlipIt includes the correct online cap", () => {
        const r = visaValidator(makeCtx({ f1OnlineCreditsPerTermCap: 3 }));
        if (r.onlineLimitSatisfied.status === "assumed-pass") {
            expect(r.onlineLimitSatisfied.whatWouldFlipIt).toContain("3");
        }
    });
});

// ---- overallWarningLevel + citations ----

describe("visaValidator — overallWarningLevel + citations", () => {
    it("domestic full-load → 'low' warning (assumed-pass on online axes pre-Phase-15)", () => {
        const r = visaValidator(makeCtx({ termCredits: 16, profile: { visaStatus: "domestic" } }));
        expect(r.overallWarningLevel).toBe("low");
    });

    it("F-1 at full-time floor → 'low' warning (only online axes are assumed-pass)", () => {
        const r = visaValidator(makeCtx({ termCredits: 12, profile: { visaStatus: "f1" } }));
        expect(r.overallWarningLevel).toBe("low");
    });

    it("F-1 below floor without RCL → 'high' warning + RCL citation", () => {
        const r = visaValidator(makeCtx({ termCredits: 6, profile: { visaStatus: "f1" } }));
        expect(r.overallWarningLevel).toBe("high");
        expect(r.citations.some(c => /RCL/.test(c))).toBe(true);
        expect(r.citations.some(c => /OGS/.test(c))).toBe(true);
    });

    it("F-1 CPT enrolled → at least 'medium' warning + CPT citation", () => {
        const r = visaValidator(makeCtx({ termCredits: 12, profile: { visaStatus: "f1", cptEnrolled: true } }));
        expect(["medium", "high"]).toContain(r.overallWarningLevel);
        expect(r.citations.some(c => /CPT/.test(c))).toBe(true);
    });

    it("F-1 final-term below floor without exception → 'high' warning + final-term citation", () => {
        const r = visaValidator(makeCtx({
            termCredits: 6,
            profile: { visaStatus: "f1", isFinalTerm: true },
        }));
        expect(r.overallWarningLevel).toBe("high");
        expect(r.citations.some(c => /Final-Term/.test(c))).toBe(true);
    });

    it("online limit assumed-pass → citation for F-1 online cap included", () => {
        const r = visaValidator(makeCtx({ termCredits: 12, profile: { visaStatus: "f1" } }));
        expect(r.citations.some(c => /Online Course Limit/.test(c))).toBe(true);
    });

    it("domestic students do NOT receive the F-1 online-cap citation", () => {
        const r = visaValidator(makeCtx({ termCredits: 16, profile: { visaStatus: "domestic" } }));
        expect(r.citations.some(c => /Online Course Limit/.test(c))).toBe(false);
        // The axis itself still returns assumed-pass (Phase 15 promotes for
        // every student); only the F-1-labelled citation is suppressed.
        expect(r.onlineLimitSatisfied.status).toBe("assumed-pass");
    });
});
