// ============================================================
// Phase 6 WS7b — get_credit_caps + search_availability tool tests
// ============================================================

import { describe, expect, it } from "vitest";
import {
    getCreditCapsTool,
    searchAvailabilityTool,
    type ToolSession,
} from "../../src/agent/index.js";
import type { SchoolConfig } from "@nyupath/shared";

const CAS_CONFIG: SchoolConfig = {
    schoolId: "cas",
    name: "College of Arts and Science",
    degreeType: "BA",
    courseSuffix: ["-UA"],
    totalCreditsRequired: 128,
    overallGpaMin: 2.0,
    auditMode: "full",
    residency: { minCredits: 64, kind: "credits" },
    creditCaps: [
        { type: "non_home_school", maxCredits: 16 },
    ],
    acceptsTransferCredit: true,
    maxCreditsPerSemester: 18,
    overloadRequirements: [
        { aboveCredits: 18, requirement: "advisor_approval" },
    ],
};

const ctx = (session: ToolSession) => ({ signal: new AbortController().signal, session });

describe("get_credit_caps tool (Phase 6 WS7b)", () => {
    it("returns the school's per-semester ceiling and cross-school caps", async () => {
        const session: ToolSession = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
                visaStatus: "domestic",
            },
            schoolConfig: CAS_CONFIG,
        };
        const out = await getCreditCapsTool.call({}, ctx(session)) as {
            schoolId: string;
            perSemesterCeiling: number | null;
            f1FullTimeFloor: number | null;
            crossSchoolCaps: Array<{ type: string; maxCredits: number }>;
            totalCreditsRequired: number | null;
        };
        expect(out.schoolId).toBe("cas");
        expect(out.perSemesterCeiling).toBe(18);
        expect(out.f1FullTimeFloor).toBeNull();
        expect(out.crossSchoolCaps).toHaveLength(1);
        expect(out.crossSchoolCaps[0]!.type).toBe("non_home_school");
        expect(out.totalCreditsRequired).toBe(128);
    });

    it("surfaces the F-1 full-time floor when visaStatus === 'f1'", async () => {
        const session: ToolSession = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
                visaStatus: "f1",
            },
            schoolConfig: CAS_CONFIG,
        };
        const out = await getCreditCapsTool.call({}, ctx(session)) as {
            f1FullTimeFloor: number | null;
            visaStatus: string;
        };
        expect(out.f1FullTimeFloor).toBe(12);
        expect(out.visaStatus).toBe("f1");
    });

    it("rejects when no schoolConfig is loaded", async () => {
        const session: ToolSession = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
            },
        };
        const v = await getCreditCapsTool.validateInput!({}, ctx(session));
        expect(v.ok).toBe(false);
        if (v.ok) return;
        expect(v.userMessage).toMatch(/school config not loaded/i);
    });

    it("summarizeResult includes the F-1 floor only when applicable", async () => {
        const sessF1: ToolSession = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
                visaStatus: "f1",
            },
            schoolConfig: CAS_CONFIG,
        };
        const out = await getCreditCapsTool.call({}, ctx(sessF1));
        const sumF1 = getCreditCapsTool.summarizeResult(out);
        expect(sumF1).toMatch(/F-1 full-time floor: 12/);

        const sessDom: ToolSession = {
            ...sessF1,
            student: { ...sessF1.student!, visaStatus: "domestic" },
        };
        const outDom = await getCreditCapsTool.call({}, ctx(sessDom));
        const sumDom = getCreditCapsTool.summarizeResult(outDom);
        expect(sumDom).not.toMatch(/F-1 full-time floor/);
    });
});

describe("search_availability tool (Phase 6 WS7b)", () => {
    type FoseRow = {
        key: string; code: string; title: string; crn: string; srcdb: string; stat: string;
        instr?: string; credits?: string;
    };
    function makeStub(rows: FoseRow[]) {
        return async (_termCode: string, _keyword: string) => rows;
    }

    it("rejects an invalid (non-4-digit) termCode at Zod time", async () => {
        const result = searchAvailabilityTool.inputSchema.safeParse({ termCode: "spring-2025", keyword: "CSCI-UA" });
        expect(result.success).toBe(false);
    });

    it("returns sections grouped by code with open/waitlist/closed counts", async () => {
        const session: ToolSession & { searchAvailabilityFn?: unknown } = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            searchAvailabilityFn: makeStub([
                { key: "1", code: "CSCI-UA 101", title: "Intro to CS", crn: "10001", srcdb: "1254", stat: "O", instr: "Smith", credits: "4" },
                { key: "2", code: "CSCI-UA 101", title: "Intro to CS", crn: "10002", srcdb: "1254", stat: "W", instr: "Jones", credits: "4" },
                { key: "3", code: "CSCI-UA 102", title: "Data Structures", crn: "10010", srcdb: "1254", stat: "C", instr: "Lee", credits: "4" },
            ]) as never,
        };
        const out = await searchAvailabilityTool.call(
            { termCode: "1254", keyword: "CSCI-UA" },
            ctx(session),
        ) as {
            termCode: string;
            sections: Array<{ code: string; statLabel: string }>;
            totalReturned: number;
        };
        expect(out.totalReturned).toBe(3);
        expect(out.sections.map((s) => s.statLabel).sort()).toEqual(["closed", "open", "waitlist"]);
        const summary = searchAvailabilityTool.summarizeResult(out);
        expect(summary).toMatch(/CSCI-UA 101.*2 sections.*1 open.*1 waitlist/);
        expect(summary).toMatch(/CSCI-UA 102.*1 sections.*1 closed/);
    });

    it("caps results at 25 sections", async () => {
        const many = Array.from({ length: 50 }, (_, i) => ({
            key: String(i),
            code: "CSCI-UA 101",
            title: "Intro",
            crn: String(10000 + i),
            srcdb: "1254",
            stat: "O",
        }));
        const session: ToolSession & { searchAvailabilityFn?: unknown } = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
            },
            searchAvailabilityFn: makeStub(many) as never,
        };
        const out = await searchAvailabilityTool.call(
            { termCode: "1254", keyword: "CSCI-UA" },
            ctx(session),
        ) as { totalReturned: number; totalAvailable: number };
        expect(out.totalReturned).toBe(25);
        expect(out.totalAvailable).toBe(50);
    });

    it("summarizeResult signals 'no sections found' on empty results", async () => {
        const session: ToolSession & { searchAvailabilityFn?: unknown } = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
            },
            searchAvailabilityFn: makeStub([]) as never,
        };
        const out = await searchAvailabilityTool.call(
            { termCode: "1254", keyword: "ZZZZ-XX 999" },
            ctx(session),
        );
        const summary = searchAvailabilityTool.summarizeResult(out);
        expect(summary).toMatch(/No sections found/i);
    });
});
