// ============================================================
// Phase 6.1 WS2 — buildStudentProfileV2 unit tests
// ============================================================

import { describe, expect, it } from "vitest";
import { buildStudentProfileV2 } from "../lib/buildSession";

describe("buildStudentProfileV2 (Phase 6.1 WS2)", () => {
    it("emits the canonical ProgramDeclaration[] shape (not the legacy string array)", () => {
        const p = buildStudentProfileV2({
            semesters: [
                {
                    term: "2024-fall",
                    courses: [{ courseId: "CSCI-UA 0101", title: "Intro", credits: 4, grade: "A" }],
                },
            ],
        }, "domestic");
        expect(p.declaredPrograms).toEqual([
            { programId: "cs_major_ba", programType: "major" },
        ]);
        expect(p.homeSchool).toBe("cas");
    });

    it("normalizes leading-zero course ids ('CSCI-UA 0101' → 'CSCI-UA 101')", () => {
        const p = buildStudentProfileV2({
            semesters: [
                {
                    term: "2024-fall",
                    courses: [{ courseId: "CSCI-UA 0101", title: "Intro", credits: 4, grade: "A" }],
                },
            ],
        });
        expect(p.coursesTaken[0]!.courseId).toBe("CSCI-UA 101");
    });

    it("includes currentSemester courses in coursesTaken with grade='C' (assumed passing)", () => {
        const p = buildStudentProfileV2({
            semesters: [],
            currentSemester: {
                term: "2025-spring",
                courses: [{ courseId: "CSCI-UA 0102", title: "Data Structures", credits: 4 }],
            },
        });
        expect(p.coursesTaken).toHaveLength(1);
        expect(p.coursesTaken[0]!.grade).toBe("C");
        expect(p.currentSemester?.courses[0]!.courseId).toBe("CSCI-UA 102");
    });

    it("derives catalogYear as a YYYY-YYYY range from the earliest semester year (P3 reviewer fix)", () => {
        const p = buildStudentProfileV2({
            semesters: [
                { term: "2024-fall", courses: [] },
                { term: "2023-fall", courses: [] },
                { term: "2025-spring", courses: [] },
            ],
        });
        // Was "2023" (bare year) pre-fix; now a range matching the
        // engine's canonical catalogYear format (e.g., "2023-2024").
        expect(p.catalogYear).toBe("2023-2024");
    });

    it("falls back to '2025-2026' when no semesters are present", () => {
        const p = buildStudentProfileV2({ semesters: [] });
        expect(p.catalogYear).toBe("2025-2026");
    });

    it("respects the catalogYearOverride", () => {
        const p = buildStudentProfileV2(
            { semesters: [{ term: "2024-fall", courses: [] }] },
            undefined,
            "2025-2026",
        );
        expect(p.catalogYear).toBe("2025-2026");
    });

    it("sets visaStatus='f1' only when explicitly 'f1'", () => {
        expect(buildStudentProfileV2({ semesters: [] }, "f1").visaStatus).toBe("f1");
        expect(buildStudentProfileV2({ semesters: [] }, "domestic").visaStatus).toBe("domestic");
        expect(buildStudentProfileV2({ semesters: [] }, undefined).visaStatus).toBe("domestic");
    });

    it("sums testCredits into genericTransferCredits", () => {
        const p = buildStudentProfileV2({
            semesters: [],
            testCredits: [
                { credits: 4, component: "AP Calc BC" },
                { credits: 4, component: "AP Bio" },
            ],
        });
        expect(p.genericTransferCredits).toBe(8);
    });
});
