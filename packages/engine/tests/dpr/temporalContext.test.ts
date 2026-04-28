// ============================================================
// Phase 8 calendar-fix — temporal context with wall-clock disambiguation
// ============================================================
// Pre-Phase-8 deriveTemporalContext picked the LATEST DPR IP-row
// term as `currentTerm`. That broke for students who had pre-
// registered for a future term (DPR has 2 IP-row terms). The fix
// uses today + the NYU calendar to disambiguate.
// ============================================================

import { describe, expect, it } from "vitest";
import { deriveTemporalContext, termInSession } from "../../src/dpr/temporalContext.js";
import { mkDpr, mkCourse } from "../helpers/mkDpr.js";

describe("termInSession (calendar truth)", () => {
    it("April → Spring", () => {
        expect(termInSession(new Date("2026-04-15T12:00:00Z"))).toEqual({ year: 2026, season: "Spring" });
    });
    it("July → Summer", () => {
        expect(termInSession(new Date("2026-07-01T12:00:00Z"))).toEqual({ year: 2026, season: "Summer" });
    });
    it("September → Fall", () => {
        expect(termInSession(new Date("2026-09-15T12:00:00Z"))).toEqual({ year: 2026, season: "Fall" });
    });
    it("November → Fall (still fall, not next-spring registration window)", () => {
        expect(termInSession(new Date("2026-11-30T12:00:00Z"))).toEqual({ year: 2026, season: "Fall" });
    });
});

describe("deriveTemporalContext — wall-clock disambiguation", () => {
    it("when today is Spring AND student is enrolled in Spring with Fall pre-registered → current=Spring, next=Fall, preReg=[Fall]", () => {
        // The bug case the operator caught: student in Spring 2026,
        // already registered for Fall 2026.
        const dpr = mkDpr({
            courseHistory: [
                mkCourse({ term: "2026 Spr", courseId: "MATH-UA 334", grade: null, type: "IP" }),
                mkCourse({ term: "2026 Fall", courseId: "MATH-UA 251", grade: null, type: "IP" }),
            ],
        });
        const ctx = deriveTemporalContext(dpr, { now: new Date("2026-04-28T12:00:00Z") });
        expect(ctx.currentTerm).toBe("Spring 2026");
        expect(ctx.nextTerm).toBe("Fall 2026");
        expect(ctx.enrolledNowTerm).toBe("Spring 2026");
        expect(ctx.preRegisteredTerms).toEqual(["Fall 2026"]);
    });

    it("when today is mid-Fall and only Fall is in IP rows → current=Fall, next=Spring, preReg empty", () => {
        const dpr = mkDpr({
            courseHistory: [
                mkCourse({ term: "2026 Fall", courseId: "CORE-UA 700", grade: null, type: "IP" }),
            ],
        });
        const ctx = deriveTemporalContext(dpr, { now: new Date("2026-10-15T12:00:00Z") });
        expect(ctx.currentTerm).toBe("Fall 2026");
        expect(ctx.nextTerm).toBe("Spring 2027");
        expect(ctx.enrolledNowTerm).toBe("Fall 2026");
        expect(ctx.preRegisteredTerms).toBeUndefined();
    });

    it("when DPR has no IP rows, currentTerm + nextTerm still come from the wall clock", () => {
        const dpr = mkDpr({ courseHistory: [] });
        const ctx = deriveTemporalContext(dpr, { now: new Date("2026-09-15T12:00:00Z") });
        expect(ctx.currentTerm).toBe("Fall 2026");
        expect(ctx.nextTerm).toBe("Spring 2027");
        expect(ctx.enrolledNowTerm).toBeUndefined();
        expect(ctx.preRegisteredTerms).toBeUndefined();
    });

    it("when the DPR is stale (only past IP rows), enrolledNowTerm falls back to the latest known term", () => {
        const dpr = mkDpr({
            courseHistory: [
                mkCourse({ term: "2025 Fall", courseId: "MATH-UA 122", grade: null, type: "IP" }),
            ],
        });
        const ctx = deriveTemporalContext(dpr, { now: new Date("2026-09-15T12:00:00Z") });
        expect(ctx.currentTerm).toBe("Fall 2026"); // wall clock
        expect(ctx.nextTerm).toBe("Spring 2027");
        expect(ctx.enrolledNowTerm).toBe("Fall 2025"); // stale DPR
        expect(ctx.preRegisteredTerms).toBeUndefined();
    });
});
