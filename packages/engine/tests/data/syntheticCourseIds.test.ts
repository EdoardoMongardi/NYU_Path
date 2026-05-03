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

// ============================================================
// Decision Y′ — Math/Language/SAT2 placement exams (Phase 12.8 Task 4)
// ============================================================

import {
    parseMathPlacementClause,
    parseLanguagePlacementClause,
    parseSAT2Clause,
    synthesizePlacementCourseId,
} from "../../../../tools/bulletin-parser/syntheticCourseIds.js";

describe("parseMathPlacementClause", () => {
    it("parses 'MATH_PLCM2 score of 100' → {level: PLCM2, score: 100}", () => {
        expect(parseMathPlacementClause("MATH_PLCM2 score of 100")).toEqual({
            level: "PLCM2",
            score: 100,
        });
    });

    it("parses 'MATH_PLCM3 score of 100' → {level: PLCM3, score: 100}", () => {
        expect(parseMathPlacementClause("MATH_PLCM3 score of 100")).toEqual({
            level: "PLCM3",
            score: 100,
        });
    });

    it("parses 'Mathematics placement exam score 85' (no level) → {score: 85}", () => {
        expect(parseMathPlacementClause("Mathematics placement exam score 85")).toEqual({
            score: 85,
        });
    });

    it("parses 'Math Placement Test score 75' (no level) → {score: 75}", () => {
        expect(parseMathPlacementClause("Math Placement Test score 75")).toEqual({
            score: 75,
        });
    });

    it("returns null for empty string", () => {
        expect(parseMathPlacementClause("")).toBeNull();
    });

    it("returns null for unrecognized format", () => {
        expect(parseMathPlacementClause("Some random text")).toBeNull();
    });
});

describe("parseLanguagePlacementClause", () => {
    it("parses 'Japanese Language Placement >= 3302' → {language: JAPANESE, score: 3302}", () => {
        expect(parseLanguagePlacementClause("Japanese Language Placement >= 3302")).toEqual({
            language: "JAPANESE",
            score: 3302,
        });
    });

    it("parses 'Korean Language Placement Score 21' → {language: KOREAN, score: 21}", () => {
        expect(parseLanguagePlacementClause("Korean Language Placement Score 21")).toEqual({
            language: "KOREAN",
            score: 21,
        });
    });

    it("parses 'Foreign language placement exam score 4' (no language) → {score: 4}", () => {
        expect(parseLanguagePlacementClause("Foreign language placement exam score 4")).toEqual({
            score: 4,
        });
    });

    it("returns null for empty string", () => {
        expect(parseLanguagePlacementClause("")).toBeNull();
    });

    it("returns null for unrecognized format", () => {
        expect(parseLanguagePlacementClause("CSCI-UA 2")).toBeNull();
    });
});

describe("parseSAT2Clause", () => {
    it("parses 'SAT II Math Level 2 score 700' → {subject: MATH2, score: 700}", () => {
        expect(parseSAT2Clause("SAT II Math Level 2 score 700")).toEqual({
            subject: "MATH2",
            score: 700,
        });
    });

    it("parses 'SAT Subject Test in Chemistry >= 650' → {subject: CHEM, score: 650}", () => {
        expect(parseSAT2Clause("SAT Subject Test in Chemistry >= 650")).toEqual({
            subject: "CHEM",
            score: 650,
        });
    });

    it("parses 'SAT II Biology >= 700' → {subject: BIO, score: 700}", () => {
        expect(parseSAT2Clause("SAT II Biology >= 700")).toEqual({
            subject: "BIO",
            score: 700,
        });
    });

    it("parses 'SAT II Physics score 650' → {subject: PHYS, score: 650}", () => {
        expect(parseSAT2Clause("SAT II Physics score 650")).toEqual({
            subject: "PHYS",
            score: 650,
        });
    });

    it("returns null for empty string", () => {
        expect(parseSAT2Clause("")).toBeNull();
    });

    it("returns null for unrecognized SAT2 subject", () => {
        expect(parseSAT2Clause("SAT II Advanced Basket Weaving score 700")).toBeNull();
    });
});

describe("synthesizePlacementCourseId", () => {
    it("synthesizes math-place with level → PLACE-MATH-PLCM2-100", () => {
        expect(
            synthesizePlacementCourseId({
                kind: "math-place",
                level: "PLCM2",
                score: 100,
            })
        ).toBe("PLACE-MATH-PLCM2-100");
    });

    it("synthesizes math-place without level → PLACE-MATH-85", () => {
        expect(
            synthesizePlacementCourseId({
                kind: "math-place",
                score: 85,
            })
        ).toBe("PLACE-MATH-85");
    });

    it("synthesizes lang-place with language → PLACE-LANG-JAPANESE-3302", () => {
        expect(
            synthesizePlacementCourseId({
                kind: "lang-place",
                language: "JAPANESE",
                score: 3302,
            })
        ).toBe("PLACE-LANG-JAPANESE-3302");
    });

    it("synthesizes lang-place without language → PLACE-LANG-4", () => {
        expect(
            synthesizePlacementCourseId({
                kind: "lang-place",
                score: 4,
            })
        ).toBe("PLACE-LANG-4");
    });

    it("synthesizes sat2 → SAT2-MATH2-700", () => {
        expect(
            synthesizePlacementCourseId({
                kind: "sat2",
                subject: "MATH2",
                score: 700,
            })
        ).toBe("SAT2-MATH2-700");
    });

    it("returns null for sat2 with no subject", () => {
        expect(
            synthesizePlacementCourseId({
                kind: "sat2",
                score: 700,
            })
        ).toBeNull();
    });
});
