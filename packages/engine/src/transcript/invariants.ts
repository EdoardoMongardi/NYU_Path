// ============================================================
// Transcript Invariants — three reconciliations (Phase 2 §11.8.3)
// ============================================================
// MUST be called by parseTranscript before returning the document.
// Throws TranscriptParseError on any failure — never falls back to
// LLM parsing per §11.8.3 ("On failure" paragraph).
// ============================================================

import { type TranscriptDocument, TranscriptParseError } from "./types.js";

const EPS = 0.01;

export function reconcileTranscript(doc: TranscriptDocument): void {
    // INVARIANT 1: per-term GPA = QPTS / QHRS (within 0.01 tolerance)
    for (const term of doc.terms) {
        if (term.qhrs <= 0) {
            // No graded credits this term (e.g., all P/F or all in-progress) — skip
            continue;
        }
        const computed = term.qpts / term.qhrs;
        if (Math.abs(computed - term.printedGpa) > EPS) {
            throw new TranscriptParseError({
                kind: "term_gpa_mismatch",
                term: term.label,
                computed: Math.round(computed * 1000) / 1000,
                printed: term.printedGpa,
            });
        }
    }

    // INVARIANT 2: sum of term QPTS == overall QPTS
    const summedQpts = doc.terms.reduce((s, t) => s + t.qpts, 0);
    if (Math.abs(summedQpts - doc.overall.qpts) > EPS) {
        throw new TranscriptParseError({
            kind: "overall_qpts_mismatch",
            summed: Math.round(summedQpts * 1000) / 1000,
            printed: doc.overall.qpts,
        });
    }

    // INVARIANT 3: cumulative GPA == overall.qpts / overall.qhrs
    if (doc.overall.qhrs > 0) {
        const computed = doc.overall.qpts / doc.overall.qhrs;
        if (Math.abs(computed - doc.overall.printedGpa) > EPS) {
            throw new TranscriptParseError({
                kind: "cumulative_gpa_mismatch",
                computed: Math.round(computed * 1000) / 1000,
                printed: doc.overall.printedGpa,
            });
        }
    }
}
