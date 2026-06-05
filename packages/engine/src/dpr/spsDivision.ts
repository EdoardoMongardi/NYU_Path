// ============================================================
// SPS division resolver (feat/sps-division-router)
// ============================================================
// Reads a DegreeProgressReport and returns which advanced-standing
// cap applies for SPS students (high confidence) or signals that
// we must ask the student (low confidence).
//
// Division rule (SPS catalog):
//   - Every SPS associate (AAS/AA) → DAUS → cap 30
//   - Among bachelor's:
//       Real Estate      → Schack Institute  → cap 64
//       Hospitality      → Tisch Center       → cap 64
//       Sport            → Tisch Institute    → cap 64
//       All other BS/BA  → DAUS              → cap 80
//
// Only the "Major" programType row is read; school-rollup and
// minor rows must not drive the division.
// ============================================================

import type { DegreeProgressReport } from "./schema.js";

export type SpsDivision = "schack" | "tisch_center" | "tisch_institute" | "daus";
export type SpsDegreeLevel = "bachelors" | "associates";

export interface SpsDivisionHigh {
    confidence: "high";
    division: SpsDivision;
    degreeLevel: SpsDegreeLevel;
    advancedStandingCap: 64 | 80 | 30;
    matchedLabel: string;
}
export interface SpsDivisionLow {
    confidence: "low";
    reason: string;
    options: ReadonlyArray<{ label: string; cap: number }>;
}
export type SpsDivisionVerdict = SpsDivisionHigh | SpsDivisionLow;

/** The three distinct advanced-standing caps, shown when we must ask. */
export const SPS_DIVISION_OPTIONS = [
    { label: "Schack Institute / Tisch Center / Tisch Institute — bachelor's", cap: 64 },
    { label: "Division of Applied Undergraduate Studies (DAUS) — bachelor's", cap: 80 },
    { label: "Division of Applied Undergraduate Studies (DAUS) — associate's", cap: 30 },
] as const;

// The three named Schack/Tisch bachelor's subjects. Every other SPS program —
// the "Applied …" bachelor's family AND all associate degrees — is DAUS.
const NAMED_UNIT_SUBJECTS: ReadonlyArray<{ re: RegExp; division: SpsDivision }> = [
    { re: /real estate/i, division: "schack" },
    { re: /hospitalit/i, division: "tisch_center" },
    { re: /sport/i, division: "tisch_institute" },
];

function degreeLevelFromLabel(label: string): SpsDegreeLevel | null {
    if (/\b(a\.?a\.?s\.?|a\.?a\.?)\b/i.test(label) || /\bassociate/i.test(label)) return "associates";
    if (/\b(b\.?s\.?|b\.?a\.?|b\.?f\.?a\.?)\b/i.test(label) || /\bbachelor/i.test(label)) return "bachelors";
    return null;
}

function bandFromCredits(creditsRequired: number | null | undefined): SpsDegreeLevel | null {
    if (typeof creditsRequired !== "number") return null;
    if (creditsRequired <= 66) return "associates";
    if (creditsRequired >= 100) return "bachelors";
    return null;
}

function capFor(division: SpsDivision, level: SpsDegreeLevel): 64 | 80 | 30 {
    if (division !== "daus") return 64; // Schack / Tisch unit bachelor's
    return level === "associates" ? 30 : 80;
}

export function resolveSpsDivision(dpr: DegreeProgressReport): SpsDivisionVerdict {
    // Only the Major row names the student's actual program; the school
    // rollup ("Sch of Prof Studies") and minors must not drive the division.
    const majors = (dpr.programs ?? []).filter((p) =>
        (p.programType ?? "").toLowerCase().includes("major"),
    );
    const creditsRequired = dpr.cumulative?.creditsRequired ?? null;
    const band = bandFromCredits(creditsRequired);

    const resolved: Array<{ division: SpsDivision; degreeLevel: SpsDegreeLevel; label: string }> = [];
    for (const p of majors) {
        const label = p.label;
        const labelLevel = degreeLevelFromLabel(label);
        const level = labelLevel ?? band;
        if (level === null) continue; // can't determine this program's level
        if (band && labelLevel && band !== labelLevel) continue; // label vs credits conflict → drop
        const division: SpsDivision = level === "bachelors"
            ? (NAMED_UNIT_SUBJECTS.find((u) => u.re.test(label))?.division ?? "daus")
            : "daus"; // every SPS associate is DAUS
        resolved.push({ division, degreeLevel: level, label });
    }

    const distinct = resolved.filter(
        (r, i) => resolved.findIndex((o) => o.division === r.division && o.degreeLevel === r.degreeLevel) === i,
    );
    if (distinct.length === 1) {
        const r = distinct[0]!;
        return {
            confidence: "high",
            division: r.division,
            degreeLevel: r.degreeLevel,
            advancedStandingCap: capFor(r.division, r.degreeLevel),
            matchedLabel: r.label,
        };
    }
    return {
        confidence: "low",
        reason: resolved.length === 0
            ? "No SPS Major program with a determinable degree level found in the DPR."
            : "SPS programs resolve to more than one division/level.",
        options: SPS_DIVISION_OPTIONS,
    };
}
