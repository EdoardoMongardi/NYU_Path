/**
 * ============================================================================
 * buildSolverInput — offerings gap-fill from session.courses[i].termsOffered
 * ============================================================================
 *
 * Resolves the limitation the P2 non-CAS pin recorded: SolverInput.offerings /
 * offeringConfidence were populated EXCLUSIVELY from the global getOfferings()
 * cache, so a course present ONLY in session.courses (a session-injected /
 * synthetic non-CAS catalog) had NO offering row even when its
 * Course.termsOffered field was populated — the solver then emitted a
 * PLACEHOLDER and the validator's requirementGroupsSatisfied axis failed.
 *
 * The fix gap-fills offerings/offeringConfidence from session.courses for ids
 * the global cache LACKS. Precedence: the global cache is AUTHORITATIVE; the
 * session only fills gaps. A session course with empty termsOffered is skipped
 * (no known offering → stays a placeholder), and the gap-filled tier is
 * "historically_likely" (a STRUCTURAL signal, not a live-FOSE confirmation).
 *
 * These tests assert ONLY on the returned SolverInput.offerings /
 * offeringConfidence maps — they do not run the full solver.
 * ============================================================================
 */

import { describe, it, expect } from "vitest";
import { buildSolverInput } from "../../src/agent/forwardSchedule/buildSolverInput.js";
import { loadOfferings } from "../../src/dataLoader.js";
import type { ToolSession } from "../../src/agent/tool.js";
import type { Course } from "@nyupath/shared";
import {
    makeNonCasShanghaiDpr,
    makeNonCasShanghaiSession,
} from "../fixtures/dpr_nonCas_synthetic.js";

describe("buildSolverInput — offerings gap-fill from session.courses.termsOffered", () => {
    // -----------------------------------------------------------------------
    // 1. (RED→GREEN) gap-fill: a session.courses entry with a synthetic id NOT
    //    in the global offerings cache, carrying a populated termsOffered, gets
    //    a real offering row + the "historically_likely" tier.
    //    RED today: offerings.get(syntheticId) === undefined.
    // -----------------------------------------------------------------------
    it("gap-fills an offering row for a session course absent from the global cache", () => {
        const dpr = makeNonCasShanghaiDpr();
        const base = makeNonCasShanghaiSession();

        // A synthetic id that cannot collide with any real global offering id.
        const syntheticId = "ZZZZ-XX 9999";
        const syntheticCourse: Course = {
            id: syntheticId,
            title: "Synthetic Gap-Fill Course",
            credits: 4,
            departments: ["ZZZZ-XX"],
            crossListed: [],
            exclusions: [],
            termsOffered: ["fall", "spring"],
            catalogYearsActive: ["2020", "2030"],
        };
        const session: ToolSession = {
            ...base,
            courses: [...(base.courses ?? []), syntheticCourse],
        };

        const solverInput = buildSolverInput(session, dpr);

        expect(solverInput.offerings.get(syntheticId)).toEqual(["fall", "spring"]);
        expect(solverInput.offeringConfidence.get(syntheticId)).toBe("historically_likely");
    });

    // -----------------------------------------------------------------------
    // 2. precedence — the global offerings cache is AUTHORITATIVE. When a
    //    session course shares an id with a REAL global offering, the global
    //    termsOffered wins; the session's deliberately-different value is
    //    IGNORED. The id + its global value are picked PROGRAMMATICALLY from
    //    the loaded map (no brittle hardcoded literal).
    // -----------------------------------------------------------------------
    it("does NOT override a global offering row with a session.courses claim (global authoritative)", () => {
        const global = loadOfferings();
        // Need a real global course whose termsOffered we can perturb into a
        // demonstrably DIFFERENT array. Pick the first global entry.
        const firstEntry = global.entries().next();
        expect(firstEntry.done).toBe(false);
        const [globalId, globalVal] = firstEntry.value as [
            string,
            { termsOffered: ReadonlyArray<"fall" | "spring" | "summer" | "january">; confidence: string },
        ];
        const globalTerms = [...globalVal.termsOffered];

        // Construct a deliberately-different session termsOffered: any single
        // season NOT deep-equal to the global one (a "summer"-only claim).
        const sessionTerms: Course["termsOffered"] = ["summer"];
        // Guard the test premise: the perturbed value must actually differ.
        expect(sessionTerms).not.toEqual(globalTerms);

        const dpr = makeNonCasShanghaiDpr();
        const base = makeNonCasShanghaiSession();
        const collidingCourse: Course = {
            id: globalId,
            title: "Session Course Colliding With A Global Id",
            credits: 4,
            departments: [globalId.split(" ")[0] ?? "XXXX-XX"],
            crossListed: [],
            exclusions: [],
            termsOffered: sessionTerms,
            catalogYearsActive: ["2020", "2030"],
        };
        const session: ToolSession = {
            ...base,
            courses: [...(base.courses ?? []), collidingCourse],
        };

        const solverInput = buildSolverInput(session, dpr);

        // Global value wins; the session's "summer"-only claim is ignored.
        expect(solverInput.offerings.get(globalId)).toEqual(globalTerms);
        expect(solverInput.offerings.get(globalId)).not.toEqual(sessionTerms);
        // Confidence stays the GLOBAL tier (not the session gap-fill tier).
        expect(solverInput.offeringConfidence.get(globalId)).toBe(globalVal.confidence);
    });

    // -----------------------------------------------------------------------
    // 3. empty guard — a session course with termsOffered: [] is intentionally
    //    skipped (no known offering → stays a placeholder). No row is created.
    // -----------------------------------------------------------------------
    it("skips a session course with empty termsOffered (stays a placeholder)", () => {
        const dpr = makeNonCasShanghaiDpr();
        const base = makeNonCasShanghaiSession();

        const emptyId = "QQQQ-XX 0001";
        const emptyCourse: Course = {
            id: emptyId,
            title: "Synthetic No-Offering Course",
            credits: 4,
            departments: ["QQQQ-XX"],
            crossListed: [],
            exclusions: [],
            termsOffered: [],
            catalogYearsActive: ["2020", "2030"],
        };
        const session: ToolSession = {
            ...base,
            courses: [...(base.courses ?? []), emptyCourse],
        };

        const solverInput = buildSolverInput(session, dpr);

        expect(solverInput.offerings.get(emptyId)).toBeUndefined();
        expect(solverInput.offeringConfidence.get(emptyId)).toBeUndefined();
    });
});
