// ============================================================
// Appendix D composite scorer (Phase 6.5 P-5)
// ============================================================
// Scores a full conversation turn against the four dimensions in
// §D.1-D.4 of ARCHITECTURE.md. Composite = the §D.5 weighted sum.
//
// The scorer is intentionally LOOSE on signal extraction: it
// substring-matches expected caveats, regex-matches forbidden
// claims, etc. Strict per-claim verification (every numeric claim
// → which tool sourced it) is partially handled by the agent's
// existing `validateResponse` (it blocks ungrounded numbers); the
// eval scorer reuses those signals where possible.
// ============================================================

import { extractClaimNumbers } from "../../packages/engine/src/agent/responseValidator.js";
import type { ToolInvocation } from "../../packages/engine/src/agent/index.js";

export interface ExpectedTurn {
    userMessage: string;
    /** Tools that MUST appear in this turn's invocations. */
    expectedToolCalls?: string[];
    /** Tools that MUST NOT appear (e.g., over-eager planning). */
    forbiddenToolCalls?: string[];
    /** Substrings the reply MUST contain (case-insensitive).
     *  Each entry is one applicable Completeness item per §D.2. */
    requiredCaveats?: string[];
    /** Regex patterns that, if matched, indicate fabrication or
     *  confident incorrect claims. Each match counts as a
     *  Non-fabrication violation. */
    forbiddenPatterns?: RegExp[];
    /** When true, the reply MUST contain an "adviser" / "consult"
     *  hedge — used for §D.3 low-confidence scenarios. */
    requiresAdviserCaveat?: boolean;
    /** Optional explicit list of valid course IDs the reply may
     *  cite. Reply mentions of any course not in this list (and
     *  matching the DEPT-XX NNN pattern) count as fabrication
     *  candidates. Skip when irrelevant to the case. */
    validCourseIds?: string[];
}

export interface TurnObservation {
    /** Final assistant text the model produced this turn. */
    assistantText: string;
    /** All tool invocations that occurred this turn. */
    invocations: ToolInvocation[];
}

export interface DimensionScores {
    grounding: number;       // [0, 1]
    completeness: number;    // [0, 1]
    uncertainty: number;     // [0, 1]
    nonFabrication: number;  // [0, 1]
}

export interface CompositeReport {
    dimensions: DimensionScores;
    composite: number;       // weighted per §D.5
    /** Per-dimension explanations (which expected items hit/missed). */
    notes: string[];
}

// Architecture §D.5 weights — pinned in source so a config drift can't
// silently rebalance the composite.
export const COMPOSITE_WEIGHTS = {
    grounding: 0.30,
    completeness: 0.35,
    uncertainty: 0.20,
    nonFabrication: 0.15,
} as const;

// ============================================================
// Per-dimension scorers
// ============================================================

function scoreGrounding(obs: TurnObservation): { score: number; notes: string[] } {
    // §D.1: every numeric/factual claim must be traceable to a tool
    // result. We approximate by extracting numeric claim tokens from
    // the reply and checking each against the tool-result corpus.
    const claims = extractClaimNumbers(obs.assistantText);
    if (claims.size === 0) return { score: 1, notes: ["no claims to ground"] };

    const corpus = obs.invocations
        .map((inv) => `${inv.summary ?? ""} ${JSON.stringify(inv.args)}`)
        .join(" ")
        .toLowerCase();
    let grounded = 0;
    const notes: string[] = [];
    for (const c of claims) {
        if (corpus.includes(c)) grounded += 1;
        else notes.push(`ungrounded claim: "${c}"`);
    }
    return { score: grounded / claims.size, notes };
}

function scoreCompleteness(
    obs: TurnObservation,
    expected: ExpectedTurn,
): { score: number; notes: string[] } {
    // §D.2: each applicable required caveat must be mentioned. A
    // substring match (case-insensitive) is the looseness floor; an
    // expected caveat also counts as mentioned if a regex form
    // pattern matches.
    const required = expected.requiredCaveats ?? [];
    if (required.length === 0) return { score: 1, notes: ["no caveats applicable"] };
    const text = obs.assistantText.toLowerCase();
    let mentioned = 0;
    const notes: string[] = [];
    for (const c of required) {
        if (text.includes(c.toLowerCase())) mentioned += 1;
        else notes.push(`missing caveat: "${c}"`);
    }
    return { score: mentioned / required.length, notes };
}

function scoreUncertainty(
    obs: TurnObservation,
    expected: ExpectedTurn,
): { score: number; notes: string[] } {
    // §D.3: low-confidence scenarios require an adviser/consult hedge.
    if (!expected.requiresAdviserCaveat) {
        return { score: 1, notes: ["no uncertainty caveat applicable"] };
    }
    const text = obs.assistantText.toLowerCase();
    const hedged = /\b(adviser|advisor|consult)\b/.test(text);
    return {
        score: hedged ? 1 : 0,
        notes: [hedged ? "adviser hedge present" : "MISSING adviser/consult hedge"],
    };
}

function scoreNonFabrication(
    obs: TurnObservation,
    expected: ExpectedTurn,
): { score: number; notes: string[] } {
    // §D.4: forbidden patterns must NOT appear. Each match is a
    // fabrication. A binary score per the spec.
    const notes: string[] = [];
    let fabricated = false;

    for (const pat of expected.forbiddenPatterns ?? []) {
        if (pat.test(obs.assistantText)) {
            fabricated = true;
            notes.push(`forbidden pattern matched: ${pat}`);
        }
    }

    // Course-ID fabrication check: if the case provides a
    // validCourseIds whitelist, any DEPT-XX NNN reference NOT in
    // the whitelist counts as a fabrication candidate.
    if (expected.validCourseIds && expected.validCourseIds.length > 0) {
        const allowed = new Set(expected.validCourseIds.map((c) => c.toUpperCase()));
        const cited = obs.assistantText.match(/[A-Z]{2,5}-[A-Z]{1,3}\s+\d{1,4}/g) ?? [];
        for (const c of cited) {
            if (!allowed.has(c.toUpperCase())) {
                fabricated = true;
                notes.push(`unrecognized course id cited: "${c}"`);
            }
        }
    }

    return { score: fabricated ? 0 : 1, notes };
}

// ============================================================
// Public API
// ============================================================

export function scoreTurn(obs: TurnObservation, expected: ExpectedTurn): CompositeReport {
    const g = scoreGrounding(obs);
    const c = scoreCompleteness(obs, expected);
    const u = scoreUncertainty(obs, expected);
    const n = scoreNonFabrication(obs, expected);
    const dimensions: DimensionScores = {
        grounding: g.score,
        completeness: c.score,
        uncertainty: u.score,
        nonFabrication: n.score,
    };
    const composite =
        COMPOSITE_WEIGHTS.grounding * g.score
        + COMPOSITE_WEIGHTS.completeness * c.score
        + COMPOSITE_WEIGHTS.uncertainty * u.score
        + COMPOSITE_WEIGHTS.nonFabrication * n.score;

    // Optional invocation-coverage check (orthogonal to §D.1-4 but
    // useful for surfacing tool-call regressions). We bundle it into
    // notes only — does NOT affect the composite.
    const notes: string[] = [
        ...g.notes.map((s) => `[grounding] ${s}`),
        ...c.notes.map((s) => `[completeness] ${s}`),
        ...u.notes.map((s) => `[uncertainty] ${s}`),
        ...n.notes.map((s) => `[non-fabrication] ${s}`),
    ];
    if (expected.expectedToolCalls && expected.expectedToolCalls.length > 0) {
        const called = new Set(obs.invocations.map((i) => i.toolName));
        for (const t of expected.expectedToolCalls) {
            if (!called.has(t)) notes.push(`[invocation] expected tool "${t}" was not called`);
        }
    }
    if (expected.forbiddenToolCalls && expected.forbiddenToolCalls.length > 0) {
        const called = new Set(obs.invocations.map((i) => i.toolName));
        for (const t of expected.forbiddenToolCalls) {
            if (called.has(t)) notes.push(`[invocation] forbidden tool "${t}" was called`);
        }
    }

    return { dimensions, composite, notes };
}

/** Aggregate per-case composites into a cohort-level score. The
 *  Phase 6.5 gate is the rolling-week average ≥ 0.90. */
export function aggregateCohort(reports: CompositeReport[]): {
    composite: number;
    dimensions: DimensionScores;
    perCaseScores: number[];
} {
    if (reports.length === 0) {
        return {
            composite: 0,
            dimensions: { grounding: 0, completeness: 0, uncertainty: 0, nonFabrication: 0 },
            perCaseScores: [],
        };
    }
    const sumDims = { grounding: 0, completeness: 0, uncertainty: 0, nonFabrication: 0 };
    const perCase: number[] = [];
    for (const r of reports) {
        sumDims.grounding += r.dimensions.grounding;
        sumDims.completeness += r.dimensions.completeness;
        sumDims.uncertainty += r.dimensions.uncertainty;
        sumDims.nonFabrication += r.dimensions.nonFabrication;
        perCase.push(r.composite);
    }
    const n = reports.length;
    const avgDims: DimensionScores = {
        grounding: sumDims.grounding / n,
        completeness: sumDims.completeness / n,
        uncertainty: sumDims.uncertainty / n,
        nonFabrication: sumDims.nonFabrication / n,
    };
    const composite =
        COMPOSITE_WEIGHTS.grounding * avgDims.grounding
        + COMPOSITE_WEIGHTS.completeness * avgDims.completeness
        + COMPOSITE_WEIGHTS.uncertainty * avgDims.uncertainty
        + COMPOSITE_WEIGHTS.nonFabrication * avgDims.nonFabrication;
    return { composite, dimensions: avgDims, perCaseScores: perCase };
}
