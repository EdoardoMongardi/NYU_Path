import { describe, it, expect } from "vitest";
import { checkPassFailLimits } from "../../src/agent/forwardSchedule/passFailLimitAxis.js";
import type { PassFailConfig } from "@nyupath/shared";

const credits32: PassFailConfig = { careerLimitType: "credits", careerLimitValue: 32 };
const courses4: PassFailConfig  = { careerLimitType: "courses", careerLimitValue: 4 };
const pct25: PassFailConfig     = { careerLimitType: "percent_of_program", careerLimitValue: 25 };
const noCap: PassFailConfig     = { careerLimitType: "credits", careerLimitValue: null };

function dprWithPf(usedUnits: number, pCourses = 0) {
    return {
        cumulative: { passFailUsedUnits: usedUnits, passFailCapUnits: 32, creditsRequired: 128 },
        courseHistory: Array.from({ length: pCourses }, (_, i) => ({ subject: "X", catalogNbr: `${i}`, grade: "P", type: "EN", units: 4, term: "2024 Fall", courseTitle: `Course ${i}` })),
    } as any;
}

describe("checkPassFailLimits (8th axis)", () => {
    it("credits cap not exceeded → pass", () => {
        expect(checkPassFailLimits(dprWithPf(28), credits32).status).toBe("pass");
    });
    it("credits cap exceeded → fail", () => {
        const r = checkPassFailLimits(dprWithPf(36), credits32);
        expect(r.status).toBe("fail");
        expect((r as any).reason).toMatch(/32/);
    });
    it("courses cap exceeded (5 P rows > 4) → fail", () => {
        expect(checkPassFailLimits(dprWithPf(0, 5), courses4).status).toBe("fail");
    });
    it("courses cap not exceeded (3 P rows ≤ 4) → pass", () => {
        expect(checkPassFailLimits(dprWithPf(0, 3), courses4).status).toBe("pass");
    });
    it("percent_of_program → requires-approval (unit-ambiguous, never hard fail)", () => {
        expect(checkPassFailLimits(dprWithPf(40), pct25).status).toBe("requires-approval");
    });
    it("null cap → assumed-pass + hedge (never blocks)", () => {
        const r = checkPassFailLimits(dprWithPf(40), noCap);
        expect(r.status).toBe("assumed-pass");
    });
    it("no passFail config → pass (axis is opt-in)", () => {
        expect(checkPassFailLimits(dprWithPf(40), undefined).status).toBe("pass");
    });
});
