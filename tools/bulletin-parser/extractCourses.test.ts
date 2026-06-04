/**
 * Step 8d — extractCourses.ts unit tests
 *
 * Pure-function coverage for the bulletin → Course catalog parser:
 *   - parseCreditRange: "(N Credits)" / variable ranges → {credits, min, max}
 *   - departmentsFromId: course-code prefix → department
 *   - isUndergradCourseId: U-vs-G undergrad scope filter
 *   - parseCoursesFromMarkdown: a dept _index.md → ParsedCourse[]
 *
 * No LLM, no filesystem (fixtures are inline strings).
 */

import { describe, it, expect } from "vitest";
import type { Course } from "@nyupath/shared";
import {
    parseCreditRange,
    departmentsFromId,
    isUndergradCourseId,
    parseCoursesFromMarkdown,
    toCourse,
    mergeCatalog,
    type ParsedCourse,
} from "./extractCourses.js";

// A dept _index.md fixture mirroring the real bulletin format: a
// fixed-credit course, a variable-credit "Yes"-repeatable course with a
// trailing Prerequisites line (which must be ignored), separated by the
// "**ID**  **Title**  **(N Credits)**" heading.
const FIXTURE = `---
url: https://bulletins.nyu.edu/courses/csci_ua/
title: "Computer Science (CSCI-UA) | NYU Bulletins"
---

# Computer Science (CSCI-UA)

**CSCI-UA 2**  **Introduction to Computer Programming (No Prior Experience)**  **(4 Credits)**

**Typically offered* Fall, Spring, and Summer terms*

An introduction to the fundamentals of computer programming. 4 points.

**Grading:** CAS Graded

**Repeatable for additional credit:** No

**CSCI-UA 480**  **Special Topics in Computer Science**  **(1-4 Credits)**

**Typically offered* Fall and Spring*

Topics vary by semester.

**Grading:** CAS Graded

**Repeatable for additional credit:** Yes

**Prerequisites:** [CSCI-UA 101](/search/?P=CSCI-UA%20101 "CSCI-UA 101").
`;

describe("parseCreditRange", () => {
    it("fixed integer credits → all three equal", () => {
        expect(parseCreditRange("4")).toEqual({ credits: 4, creditsMin: 4, creditsMax: 4 });
    });

    it("variable-credit range → credits is the MAX, min/max bracket it", () => {
        expect(parseCreditRange("1-4")).toEqual({ credits: 4, creditsMin: 1, creditsMax: 4 });
    });

    it("zero-credit course (labs/recitations)", () => {
        expect(parseCreditRange("0")).toEqual({ credits: 0, creditsMin: 0, creditsMax: 0 });
    });

    it("decimal credits", () => {
        expect(parseCreditRange("1.5")).toEqual({ credits: 1.5, creditsMin: 1.5, creditsMax: 1.5 });
    });
});

describe("departmentsFromId", () => {
    it("derives the department from the course-code prefix", () => {
        expect(departmentsFromId("CSCI-UA 101")).toEqual(["CSCI-UA"]);
    });

    it("handles digit-bearing subject prefixes (SPS)", () => {
        expect(departmentsFromId("REAL1-UC 1001")).toEqual(["REAL1-UC"]);
    });
});

describe("isUndergradCourseId (U-vs-G scope)", () => {
    it("accepts a CAS undergrad course (UA)", () => {
        expect(isUndergradCourseId("CSCI-UA 101")).toBe(true);
    });

    it("accepts an SPS undergrad course (UC)", () => {
        expect(isUndergradCourseId("REAL1-UC 1001")).toBe(true);
    });

    it("accepts a Shanghai undergrad course (SHU)", () => {
        expect(isUndergradCourseId("CSCI-SHU 101")).toBe(true);
    });

    it("rejects a graduate course (G*)", () => {
        expect(isUndergradCourseId("ACCT-GB 6000")).toBe(false);
    });

    it("rejects a professional-school course (law)", () => {
        expect(isUndergradCourseId("LAW-LW 12491")).toBe(false);
    });
});

describe("parseCoursesFromMarkdown", () => {
    it("parses one course block per heading", () => {
        const out = parseCoursesFromMarkdown(FIXTURE);
        expect(out.map((c) => c.id)).toEqual(["CSCI-UA 2", "CSCI-UA 480"]);
    });

    it("extracts title, fixed credits, terms, grading, and repeatable=No", () => {
        const c = parseCoursesFromMarkdown(FIXTURE)[0]!;
        expect(c.title).toBe("Introduction to Computer Programming (No Prior Experience)");
        expect(c.credits).toBe(4);
        expect(c.creditsMin).toBe(4);
        expect(c.creditsMax).toBe(4);
        expect(c.departments).toEqual(["CSCI-UA"]);
        expect(c.termsOffered).toEqual(["fall", "spring", "summer"]);
        expect(c.grading).toBe("CAS Graded");
        expect(c.repeatableForCredit).toBe(false);
    });

    it("takes the MAX of a variable-credit range and reads repeatable=Yes", () => {
        const c = parseCoursesFromMarkdown(FIXTURE)[1]!;
        expect(c.credits).toBe(4);
        expect(c.creditsMin).toBe(1);
        expect(c.creditsMax).toBe(4);
        expect(c.termsOffered).toEqual(["fall", "spring"]);
        expect(c.repeatableForCredit).toBe(true);
    });

    it("does not surface a prereqs field (prereqs live in prereqs.json)", () => {
        const c = parseCoursesFromMarkdown(FIXTURE)[1]!;
        expect(c).not.toHaveProperty("prereqs");
        expect(c).not.toHaveProperty("prerequisites");
    });

    it("defaults termsOffered to [fall, spring] when no 'Typically offered' line", () => {
        const md =
            "**ABCD-UA 1**  **A Course With No Offering Line**  **(4 Credits)**\n\n" +
            "Just a description.\n\n**Grading:** CAS Graded\n\n" +
            "**Repeatable for additional credit:** No\n";
        expect(parseCoursesFromMarkdown(md)[0]!.termsOffered).toEqual(["fall", "spring"]);
    });

    it("defaults termsOffered to [fall, spring] for 'occasionally' (unparseable terms)", () => {
        const md =
            "**REAL1-UC 1001**  **Real Estate Principles**  **(4 Credits)**\n\n" +
            "**Typically offered* occasionally*\n\nDesc.\n\n**Grading:** UC SPS Graded\n\n" +
            "**Repeatable for additional credit:** No\n";
        expect(parseCoursesFromMarkdown(md)[0]!.termsOffered).toEqual(["fall", "spring"]);
    });
});

describe("mergeCatalog (union — never drop a prior course)", () => {
    const mk = (id: string, credits: number, title = "x"): Course => ({
        id,
        title,
        credits,
        departments: [],
        crossListed: [],
        exclusions: [],
        termsOffered: ["fall"],
        catalogYearsActive: ["2020", "2026"],
    });

    it("keeps the bulletin version when an id is in both, output sorted by id", () => {
        const out = mergeCatalog([mk("B-UA 2", 4, "new")], [mk("B-UA 2", 3, "old"), mk("A-UA 1", 4)]);
        expect(out.map((c) => c.id)).toEqual(["A-UA 1", "B-UA 2"]);
        const b = out.find((c) => c.id === "B-UA 2")!;
        expect(b.credits).toBe(4);
        expect(b.title).toBe("new");
    });

    it("carries forward prior courses absent from the bulletin (no regression)", () => {
        const out = mergeCatalog([mk("B-UA 2", 4)], [mk("CSCI-UA 471", 4, "Machine Learning")]);
        expect(out.map((c) => c.id)).toContain("CSCI-UA 471");
    });
});

describe("toCourse", () => {
    const PARSED: ParsedCourse = {
        id: "CSCI-UA 2",
        title: "Intro to Programming",
        credits: 4,
        creditsMin: 4,
        creditsMax: 4,
        departments: ["CSCI-UA"],
        termsOffered: ["fall", "spring"],
        grading: "CAS Graded",
        repeatableForCredit: false,
    };

    it("maps parsed fields and defaults the bulletin-absent Course fields", () => {
        const c = toCourse(PARSED);
        expect(c.id).toBe("CSCI-UA 2");
        expect(c.credits).toBe(4);
        expect(c.creditsMin).toBe(4);
        expect(c.creditsMax).toBe(4);
        expect(c.grading).toBe("CAS Graded");
        expect(c.repeatableForCredit).toBe(false);
        expect(c.crossListed).toEqual([]);
        expect(c.exclusions).toEqual([]);
        expect(c.catalogYearsActive).toHaveLength(2);
    });

    it("overlays curated stub fields (crossListed/exclusions/catalogYearsActive) but bulletin wins for title/credits", () => {
        const overlay: Partial<Course> = {
            exclusions: ["CSCI-UA 110"],
            crossListed: ["DS-UA 201"],
            catalogYearsActive: ["2020", "2025"],
        };
        const c = toCourse(PARSED, overlay);
        expect(c.exclusions).toEqual(["CSCI-UA 110"]);
        expect(c.crossListed).toEqual(["DS-UA 201"]);
        expect(c.catalogYearsActive).toEqual(["2020", "2025"]);
        expect(c.title).toBe("Intro to Programming");
        expect(c.credits).toBe(4);
    });
});
