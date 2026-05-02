// ============================================================
// Phase 12.8 Task 2 — synthetic AP/IB courseId helper tests
// ============================================================
//
// TDD: tests written first; helper lives in tools/bulletin-parser/
// (workspace vitest config only globs packages/*/tests, so the
// test file lives here and imports across the workspace).
//
// Per locked Decision Y: per-exam-per-score IDs only. NO
// PLACEMENT_EXAM fallback. Unrecognized exams return null.

import { describe, expect, it } from "vitest";
import {
    parseAPClause,
    parseIBClause,
    synthesizeCourseId,
} from "../../../../tools/bulletin-parser/syntheticCourseIds.js";

describe("synthesizeCourseId — AP", () => {
    it("AP Computer Science A score 3 → AP-CS-A-3", () => {
        expect(synthesizeCourseId({ exam: "AP Computer Science A", score: 3 }))
            .toBe("AP-CS-A-3");
    });

    it("AP Calculus BC score 5 → AP-CALC-BC-5", () => {
        expect(synthesizeCourseId({ exam: "AP Calculus BC", score: 5 }))
            .toBe("AP-CALC-BC-5");
    });

    it("AP Statistics score 4 → AP-STATS-4", () => {
        expect(synthesizeCourseId({ exam: "AP Statistics", score: 4 }))
            .toBe("AP-STATS-4");
    });

    it("AP Microeconomics score 4 → AP-ECON-MICRO-4", () => {
        expect(synthesizeCourseId({ exam: "AP Microeconomics", score: 4 }))
            .toBe("AP-ECON-MICRO-4");
    });

    it("AP Art History score 5 → AP-ART-HIST-5 (extended dict)", () => {
        expect(synthesizeCourseId({ exam: "AP Art History", score: 5 }))
            .toBe("AP-ART-HIST-5");
    });

    it("is case-insensitive on the exam name", () => {
        expect(synthesizeCourseId({ exam: "ap computer science a", score: 3 }))
            .toBe("AP-CS-A-3");
    });

    it("trims whitespace on the exam name", () => {
        expect(synthesizeCourseId({ exam: "  AP Computer Science A  ", score: 3 }))
            .toBe("AP-CS-A-3");
    });
});

describe("synthesizeCourseId — IB", () => {
    it("IB Higher Level Mathematics score 6 → IB-MATH-HL-6", () => {
        expect(synthesizeCourseId({ exam: "IB Higher Level Mathematics", score: 6 }))
            .toBe("IB-MATH-HL-6");
    });

    it("IB Standard Level Computer Science score 5 → IB-CS-SL-5", () => {
        expect(synthesizeCourseId({ exam: "IB Standard Level Computer Science", score: 5 }))
            .toBe("IB-CS-SL-5");
    });

    it("IB Higher Level Psychology score 6 → IB-PSYCH-HL-6 (extended dict)", () => {
        expect(synthesizeCourseId({ exam: "IB Higher Level Psychology", score: 6 }))
            .toBe("IB-PSYCH-HL-6");
    });
});

describe("synthesizeCourseId — null cases (no PLACEMENT_EXAM fallback)", () => {
    it("Random Exam → null", () => {
        expect(synthesizeCourseId({ exam: "Random Exam", score: 5 })).toBeNull();
    });

    it("AP exam not in dict → null", () => {
        expect(synthesizeCourseId({ exam: "AP Some Unknown Exam", score: 5 }))
            .toBeNull();
    });

    it("empty exam name → null", () => {
        expect(synthesizeCourseId({ exam: "", score: 5 })).toBeNull();
    });
});

describe("parseAPClause — bulletin variants", () => {
    it("plan example: 'Advanced Placement Examination Computer Science A >= 3'", () => {
        expect(parseAPClause("Advanced Placement Examination Computer Science A >= 3"))
            .toEqual({ exam: "AP Computer Science A", score: 3 });
    });

    it("'Advanced Placement Examination Calculus BC >= 5' (chem_ua bulletin)", () => {
        expect(parseAPClause("Advanced Placement Examination Calculus BC >= 5"))
            .toEqual({ exam: "AP Calculus BC", score: 5 });
    });

    it("'Advanced Placement Examination Statistics >= 4' (real bulletin)", () => {
        expect(parseAPClause("Advanced Placement Examination Statistics >= 4"))
            .toEqual({ exam: "AP Statistics", score: 4 });
    });

    it("'Advanced Placement Examination Art History >= 5' (arth_ua bulletin)", () => {
        expect(parseAPClause("Advanced Placement Examination Art History >= 5"))
            .toEqual({ exam: "AP Art History", score: 5 });
    });

    it("hyphen subject: 'Advanced Placement Examination Economics - Microeconomics >= 4'", () => {
        expect(parseAPClause("Advanced Placement Examination Economics - Microeconomics >= 4"))
            .toEqual({ exam: "AP Microeconomics", score: 4 });
    });

    it("hyphen subject: 'Advanced Placement Examination Economics - Macroeconomics >= 4'", () => {
        expect(parseAPClause("Advanced Placement Examination Economics - Macroeconomics >= 4"))
            .toEqual({ exam: "AP Macroeconomics", score: 4 });
    });

    it("'Advanced Placement Examination Spanish Literature >= 4' (anth_ua bulletin)", () => {
        expect(parseAPClause("Advanced Placement Examination Spanish Literature >= 4"))
            .toEqual({ exam: "AP Spanish Literature", score: 4 });
    });

    it("'Advanced Placement Examination Computer Science Principles >= 4'", () => {
        expect(parseAPClause("Advanced Placement Examination Computer Science Principles >= 4"))
            .toEqual({ exam: "AP Computer Science Principles", score: 4 });
    });

    it("'AP Calculus BC >= 4' (ASCII alternative)", () => {
        expect(parseAPClause("AP Calculus BC >= 4"))
            .toEqual({ exam: "AP Calculus BC", score: 4 });
    });

    it("'AP Calculus BC ≥ 4' (Unicode operator)", () => {
        expect(parseAPClause("AP Calculus BC ≥ 4"))
            .toEqual({ exam: "AP Calculus BC", score: 4 });
    });

    it("'AP Exam Microeconomics >= 4' (econ_ua alt preamble)", () => {
        expect(parseAPClause("AP Exam Microeconomics >= 4"))
            .toEqual({ exam: "AP Microeconomics", score: 4 });
    });

    it("'AP Exam Calc AB >= 4' (phys_ua: 'Calc' shorthand)", () => {
        expect(parseAPClause("AP Exam Calc AB >= 4"))
            .toEqual({ exam: "AP Calculus AB", score: 4 });
    });

    it("'AP Exam Calc BC >= 4' (phys_ua: 'Calc' shorthand)", () => {
        expect(parseAPClause("AP Exam Calc BC >= 4"))
            .toEqual({ exam: "AP Calculus BC", score: 4 });
    });

    it("no-space operator: 'AP Exam Psychology >=4' (psych_ua bulletin)", () => {
        expect(parseAPClause("AP Exam Psychology >=4"))
            .toEqual({ exam: "AP Psychology", score: 4 });
    });

    it("no AP clause in plain prereq: 'CSCI-UA 2 with a Minimum Grade of C' → null", () => {
        expect(parseAPClause("CSCI-UA 2 with a Minimum Grade of C")).toBeNull();
    });

    it("returns null when string is empty", () => {
        expect(parseAPClause("")).toBeNull();
    });

    it("extracts AP portion from a longer surrounding clause", () => {
        const text =
            "(CSCI-UA 2 with a Minimum Grade of C OR Advanced Placement Examination Computer Science A >= 3)";
        expect(parseAPClause(text))
            .toEqual({ exam: "AP Computer Science A", score: 3 });
    });

    it("returns null for bare 'AP SCORE GREATER OR EQUAL TO 4' (no subject in psych_ua)", () => {
        // Bulletin's bare AP variant has no subject — caller must skip.
        expect(parseAPClause("AP SCORE GREATER OR EQUAL TO 4")).toBeNull();
    });

    it("returns null when subject is unknown to the dictionary", () => {
        expect(parseAPClause("Advanced Placement Examination Underwater Basket Weaving >= 5"))
            .toBeNull();
    });
});

describe("parseIBClause — bulletin variants", () => {
    it("'IB HL Psychology Score >= 6' (psych_ua bulletin)", () => {
        expect(parseIBClause("IB HL Psychology Score >= 6"))
            .toEqual({ exam: "IB Higher Level Psychology", score: 6 });
    });

    it("'IB Higher Level Mathematics >= 5'", () => {
        expect(parseIBClause("IB Higher Level Mathematics >= 5"))
            .toEqual({ exam: "IB Higher Level Mathematics", score: 5 });
    });

    it("'IB Standard Level Mathematics >= 6'", () => {
        expect(parseIBClause("IB Standard Level Mathematics >= 6"))
            .toEqual({ exam: "IB Standard Level Mathematics", score: 6 });
    });

    it("'IB SL Computer Science >= 5' (abbreviated)", () => {
        expect(parseIBClause("IB SL Computer Science >= 5"))
            .toEqual({ exam: "IB Standard Level Computer Science", score: 5 });
    });

    it("Unicode operator: 'IB HL Mathematics ≥ 6'", () => {
        expect(parseIBClause("IB HL Mathematics ≥ 6"))
            .toEqual({ exam: "IB Higher Level Mathematics", score: 6 });
    });

    it("returns null for bare 'IB SCORE GREATER OR EQUAL TO 6' (no subject)", () => {
        expect(parseIBClause("IB SCORE GREATER OR EQUAL TO 6")).toBeNull();
    });

    it("returns null when no IB clause: 'CSCI-UA 2 with a Minimum Grade of C'", () => {
        expect(parseIBClause("CSCI-UA 2 with a Minimum Grade of C")).toBeNull();
    });

    it("returns null when string is empty", () => {
        expect(parseIBClause("")).toBeNull();
    });

    it("extracts IB portion from a longer surrounding clause", () => {
        const text =
            "(PSYCH-UA 1 OR UAPSYCBA OR IB HL Psychology Score >= 6 OR APSY-UE 2)";
        expect(parseIBClause(text))
            .toEqual({ exam: "IB Higher Level Psychology", score: 6 });
    });

    it("returns null for unknown IB subject", () => {
        expect(parseIBClause("IB HL Underwater Basket Weaving >= 6")).toBeNull();
    });
});
