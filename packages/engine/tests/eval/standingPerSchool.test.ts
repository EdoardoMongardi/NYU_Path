// ============================================================
// Per-school academic standing — completion-rate is config-driven
// ============================================================
// Step 8e follow-up: the credit-completion-rate dismissal + warning
// are a per-school rule, not a universal NYU default. Only schools whose
// config publishes a `completionRatePolicy` apply pace-based standing;
// GPA-only / tiered schools (Stern, Tandon, Steinhardt, Nursing) get NO
// completion-rate dismissal or "below X%" warning. The hard dismissal
// mechanic ("below D% after N semesters → dismissed") is itself opt-in:
// only schools whose policy carries `dismissalThreshold` +
// `dismissalAfterSemesters` (e.g. CAS, bulletin L494) can be dismissed
// on completion-rate grounds.
// ============================================================

import { describe, expect, it } from "vitest";
import { calculateStanding } from "../../src/audit/academicStanding.js";
import { loadSchoolConfig } from "../../src/dataLoader.js";

const stern = loadSchoolConfig("stern")!; // no completionRatePolicy
const cas = loadSchoolConfig("cas")!; // full policy: 0.75 / dismiss <0.5 after 2
const tisch = loadSchoolConfig("tisch")!; // goodStanding 0.5, NO dismissal mechanic
const gallatin = loadSchoolConfig("gallatin")!; // annual 0.76 pace basis
const shanghai = loadSchoolConfig("shanghai")!; // per-term 0.5 pace basis

// 2 A + 1 F → 8 of 12 attempted credits completed (66.7%), GPA 2.667.
const SUB75 = [
    { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
    { courseId: "X2", grade: "A", semester: "2024-fall", credits: 4 },
    { courseId: "X3", grade: "F", semester: "2024-fall", credits: 4 },
];

describe("completion-rate standing is gated on a per-school policy", () => {
    it("a school with no completion-rate policy is NOT dismissed for low completion (Stern)", () => {
        // 1 A + 3 W after 2 semesters → 25% completion, GPA 4.0.
        // CAS would dismiss this; Stern has no pace rule, so high GPA wins.
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "W", semester: "2024-fall", credits: 4 },
                { courseId: "X3", grade: "W", semester: "2025-spring", credits: 4 },
                { courseId: "X4", grade: "W", semester: "2025-spring", credits: 4 },
            ],
            2,
            stern,
        );
        expect(r.completionRate).toBe(0.25);
        expect(r.cumulativeGPA).toBe(4.0);
        expect(r.level).toBe("good_standing");
    });

    it("a school with no completion-rate policy emits NO 'below threshold' completion warning (Stern)", () => {
        // 2 A + 1 F → 66.7% completion (< any CAS 75% floor), GPA 2.667.
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X3", grade: "F", semester: "2024-fall", credits: 4 },
            ],
            1,
            stern,
        );
        expect(r.cumulativeGPA).toBeGreaterThan(2.0);
        expect(r.level).toBe("good_standing");
        expect(r.warnings.some((w) => w.toLowerCase().includes("completion"))).toBe(false);
    });

    it("CAS (publishes a policy) DOES warn when completion is below its 75% threshold", () => {
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X3", grade: "F", semester: "2024-fall", credits: 4 },
            ],
            1,
            cas,
        );
        expect(r.warnings.some((w) => w.toLowerCase().includes("completion"))).toBe(true);
    });

    it("CAS DOES dismiss at <50% completion after 2 semesters (bulletin L494)", () => {
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "W", semester: "2024-fall", credits: 4 },
                { courseId: "X3", grade: "W", semester: "2025-spring", credits: 4 },
                { courseId: "X4", grade: "W", semester: "2025-spring", credits: 4 },
            ],
            2,
            cas,
        );
        expect(r.cumulativeGPA).toBe(4.0);
        expect(r.level).toBe("dismissed");
    });

    it("a completion-rate school WITHOUT a dismissal mechanic warns but never dismisses (Tisch)", () => {
        // Tisch publishes a 50% good-standing-return threshold but no hard
        // "dismiss after N semesters" rule → warn below 50%, never dismiss.
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "W", semester: "2024-fall", credits: 4 },
                { courseId: "X3", grade: "W", semester: "2025-spring", credits: 4 },
                { courseId: "X4", grade: "W", semester: "2025-spring", credits: 4 },
            ],
            2,
            tisch,
        );
        expect(r.completionRate).toBe(0.25);
        expect(r.level).not.toBe("dismissed");
        expect(r.level).toBe("good_standing");
        expect(r.warnings.some((w) => w.toLowerCase().includes("completion"))).toBe(true);
    });
});

describe("completion-rate warning text reflects each school's pace basis", () => {
    const warningFor = (cfg: typeof cas, courses = SUB75) =>
        calculateStanding(courses, 1, cfg).warnings.find((w) =>
            w.toLowerCase().includes("completion"),
        ) ?? "";

    it("a cumulative-basis school (CAS) names cumulative attempted credits", () => {
        const w = warningFor(cas);
        expect(w).toContain("75%");
        expect(w.toLowerCase()).toContain("cumulative attempted credits");
        expect(w.toLowerCase()).not.toContain("each academic year");
        expect(w.toLowerCase()).not.toContain("each term");
    });

    it("an annual-basis school (Gallatin) says the threshold is per academic year", () => {
        const w = warningFor(gallatin);
        expect(w).toContain("76%");
        expect(w.toLowerCase()).toContain("each academic year");
    });

    it("a per-term-basis school (Shanghai) says the threshold is per term", () => {
        // 1 A + 2 W → 33% completion (< 50%).
        const courses = [
            { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
            { courseId: "X2", grade: "W", semester: "2024-fall", credits: 4 },
            { courseId: "X3", grade: "W", semester: "2024-fall", credits: 4 },
        ];
        const w = warningFor(shanghai, courses);
        expect(w).toContain("50%");
        expect(w.toLowerCase()).toContain("each term");
    });
});
