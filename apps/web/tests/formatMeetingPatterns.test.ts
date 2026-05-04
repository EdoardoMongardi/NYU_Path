// ============================================================
// formatMeetingPatterns.test.ts — Phase 15 Task 8
// ============================================================
// Pure helpers backing the sidebar's Sections view. Component-level
// behavior (picker tabs, banner rendering, "Apply combination" button)
// is operator-verified in the browser per the Phase 15 plan; only the
// time-formatting helpers carry enough logic to warrant a unit test.
// ============================================================

import { describe, it, expect } from "vitest";
import { formatHmm, formatPatterns } from "../lib/formatMeetingPatterns";
import type { MeetingPattern } from "@nyupath/shared";

describe("formatHmm", () => {
    it("formats midnight + noon at 12h boundaries", () => {
        expect(formatHmm(0)).toBe("12a");
        expect(formatHmm(12 * 60)).toBe("12p");
    });

    it("drops :00 minutes", () => {
        expect(formatHmm(9 * 60)).toBe("9a");          // 9:00 AM
        expect(formatHmm(13 * 60)).toBe("1p");         // 1:00 PM
        expect(formatHmm(23 * 60)).toBe("11p");        // 11:00 PM
    });

    it("preserves minute precision when non-zero", () => {
        expect(formatHmm(8 * 60)).toBe("8a");           // 8:00 AM
        expect(formatHmm(8 * 60 + 30)).toBe("8:30a");   // 8:30 AM
        expect(formatHmm(9 * 60 + 15)).toBe("9:15a");   // 9:15 AM
        expect(formatHmm(14 * 60 + 45)).toBe("2:45p");  // 2:45 PM
    });

    it("zero-pads single-digit minutes", () => {
        expect(formatHmm(8 * 60 + 5)).toBe("8:05a");   // 8:05 AM, NOT "8:5a"
        expect(formatHmm(15 * 60 + 9)).toBe("3:09p");  // 3:09 PM
    });

    it("rolls over at the AM/PM boundary correctly", () => {
        expect(formatHmm(11 * 60 + 59)).toBe("11:59a");
        expect(formatHmm(12 * 60 + 1)).toBe("12:01p");
    });
});

describe("formatPatterns", () => {
    it("returns 'Asynchronous' for an empty pattern list", () => {
        expect(formatPatterns([])).toBe("Asynchronous");
    });

    it("formats a single Tuesday/Thursday pattern", () => {
        const patterns: MeetingPattern[] = [
            { day: "Tu", startMin: 8 * 60, endMin: 9 * 60 + 15 },
        ];
        expect(formatPatterns(patterns)).toBe("Tu 8a–9:15a");
    });

    it("joins multiple weekly patterns with the bullet separator", () => {
        const patterns: MeetingPattern[] = [
            { day: "Tu", startMin: 8 * 60, endMin: 9 * 60 + 15 },
            { day: "Th", startMin: 8 * 60, endMin: 9 * 60 + 15 },
        ];
        expect(formatPatterns(patterns)).toBe("Tu 8a–9:15a · Th 8a–9:15a");
    });

    it("handles an MWF afternoon block", () => {
        const patterns: MeetingPattern[] = [
            { day: "M", startMin: 13 * 60, endMin: 13 * 60 + 50 },
            { day: "W", startMin: 13 * 60, endMin: 13 * 60 + 50 },
            { day: "F", startMin: 13 * 60, endMin: 13 * 60 + 50 },
        ];
        expect(formatPatterns(patterns)).toBe("M 1p–1:50p · W 1p–1:50p · F 1p–1:50p");
    });
});
