// ============================================================
// D7.1 — Proactive elicitation detector (PURE, deterministic)
// ============================================================
// Sibling to clarifier.ts. The REACTIVE clarifier (`detectAmbiguity`)
// owns genuinely-ambiguous messages and the route SUBSTITUTES a
// clarifying question for the agent loop. This PROACTIVE detector is
// the OPPOSITE: it owns CLEAR-but-context-thin planning questions where
// a professional adviser would ANSWER first and then APPEND ONE focused
// question to gather the missing decision-relevant fact.
//
// IMPORTANT — APPEND, NOT SUBSTITUTE. This function is a pure detector:
// it returns a structured `ElicitationReport` and MUST NOT stream,
// early-return, or substitute a question for the answer. D7.2 will
// consume this AFTER the agent loop completes to APPEND a bounded ask —
// it must NOT mirror the route clarifier anti-pattern (route.ts ~428-465
// streams the clarifier question and `return`s, so the agent loop never
// runs). See the export comment for the wiring contract.
//
// Design contract (BINDING — conservative / bounded):
//   - Fire on HIGH-VALUE, LOW-FREQUENCY opportunities only. Default
//     `shouldElicit:false`. False positives are worse than misses: a
//     real adviser asks proactively but does NOT interrogate.
//   - A signal fires only when BOTH (a) the message expresses a
//     planning/decision intent AND (b) a specific decision-relevant fact
//     is demonstrably ABSENT from `studentContext` / `history`.
//   - We SUPPRESS overlap with the reactive clarifier: if
//     `detectAmbiguity` would already fire, the elicitor stays silent
//     (the clarifier owns ambiguous messages; the elicitor owns
//     clear-but-thin ones). We also suppress on pure factual lookups and
//     on continuations of a prior assistant question.
// ============================================================

import type { LLMMessage } from "./llmClient.js";
import { detectAmbiguity } from "./clarifier.js";

export type ElicitationSignal =
    // Forward-planning / recommendation intent but the student has not
    // declared a program — the intended major/direction is the single
    // fact that most changes the recommendation. Low-frequency because
    // most planning questions arrive AFTER a program is declared.
    | "planning_without_declared_program"
    // The student is exploring a major/minor CHOICE with no career/
    // interest cue anywhere in scope — the adviser would ask the goal
    // that disambiguates the choice. Low-frequency: gated on explicit
    // "should I major / which major / thinking about a minor" framing.
    | "major_exploration_without_interest"
    // Home school is a GLOBAL campus (NYU Shanghai / NYU Abu Dhabi) and
    // the student wants a multi-term plan with no study-away mention —
    // study-away intent materially changes term sequencing. Inherently
    // low-frequency: only the two global campuses reach this branch.
    | "global_campus_planning_without_away_intent";

export interface ElicitationReport {
    shouldElicit: boolean;
    signals: ElicitationSignal[];
    /** A short topic key naming what to ask about (for D7.2 + telemetry). */
    topic?: string;
}

// Global (away-program-eligible) home campuses. Grounded in the real
// homeSchool ids: the school-config basenames + SCHOOL_DISPLAY_NAMES in
// `data/schoolDefaults.ts` ("nyuad" = NYU Abu Dhabi, "shanghai" = NYU
// Shanghai). Compared case-insensitively, mirroring schoolDisplayName.
const GLOBAL_CAMPUSES = new Set(["nyuad", "shanghai"]);

// Forward-planning / recommendation intent. Deliberately tight — the
// kind of question where the intended direction changes the answer.
const PLANNING_INTENT_RE =
    /\b(?:what should i take|should i take|plan(?:\s+(?:out|my))?|next semester|next few semesters|remaining semesters|map out|on track|graduate|graduation|course plan|schedule my|which courses)\b/i;

// Major/minor EXPLORATION (a choice being weighed), distinct from a
// settled "declare my major" instruction.
const MAJOR_EXPLORATION_RE =
    /\b(?:should i (?:major|minor)|thinking about (?:a |an )?(?:major|minor)|adding a (?:major|minor)|which (?:major|minor)|major in|pick a (?:major|minor)|choose a (?:major|minor)|declare a (?:major|minor)\?)\b/i;

// A career / interest / goal cue — when present, the adviser already has
// the direction and need NOT ask.
const INTEREST_CUE_RE =
    /\b(?:i (?:want|like|love|enjoy|hope|plan|aim) to|interested in|interest in|career in|work in|passionate about|my goal|i'?m into|go into|end up (?:in|as)|become an?)\b/i;

// Study-away intent (any mention means the global-campus away question
// is already answered).
const STUDY_AWAY_RE =
    /\b(?:study away|study abroad|abroad|away (?:site|semester|term|year)|spend a semester (?:in|at|away)|go to (?:new york|nyu (?:ny|new york))|new york campus|away program|global site)\b/i;

// Pure factual / self-lookup questions the elicitor must never touch —
// they don't depend on the student's direction. (Sibling to the
// clarifier's FIRST_PERSON_VERB anchor; kept local so the two detectors
// stay independent.)
const PURE_LOOKUP_RE =
    /\b(?:what(?:'s| is| are) my|how many (?:credits|courses)|my gpa|what'?s my gpa|residency requirement|add\/?drop deadline|prerequisites? for|is .* offered|count toward|count towards|pass\/?fail|when is the)\b/i;

function recentHistoryText(history: ReadonlyArray<LLMMessage>): string {
    return history
        .slice(-6)
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join(" ");
}

/** Mirror of the clarifier's `priorTurnIsContinuationContext`: a short
 *  reply to a prior assistant QUESTION is a continuation, not a fresh
 *  context-thin planning ask. */
function priorTurnIsContinuation(history: ReadonlyArray<LLMMessage>): boolean {
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    const text = lastAssistant && typeof lastAssistant.content === "string"
        ? lastAssistant.content.trim()
        : "";
    return text.length > 0 && /\?\s*$/.test(text);
}

/**
 * Decide whether the user's message is a CLEAR planning question that is
 * THIN on one decision-relevant fact — the kind a professional adviser
 * would answer first, then probe with ONE focused follow-up.
 *
 * Pure deterministic. Returns a structured report; NEVER streams,
 * early-returns, or substitutes a question for the answer.
 */
export function detectElicitationOpportunity(
    userMessage: string,
    history: ReadonlyArray<LLMMessage>,
    studentContext: { homeSchool?: string; declaredPrograms?: string[]; visaStatus?: string },
): ElicitationReport {
    const text = userMessage.trim();
    const signals: ElicitationSignal[] = [];
    let topic: string | undefined;

    // ---- Universal suppressors (return early-silent, NOT a substitute) ----
    // Empty message → nothing to elicit.
    if (text.length === 0) return { shouldElicit: false, signals };
    // The reactive clarifier owns ambiguous messages — don't double-fire.
    if (detectAmbiguity(userMessage, history).ambiguous) return { shouldElicit: false, signals };
    // A short reply to a prior assistant question is a continuation.
    if (priorTurnIsContinuation(history)) return { shouldElicit: false, signals };
    // Pure factual / self-lookup questions don't depend on direction.
    if (PURE_LOOKUP_RE.test(text)) return { shouldElicit: false, signals };

    const lower = text.toLowerCase();
    const homeSchool = (studentContext.homeSchool ?? "").toLowerCase();
    const hasDeclaredProgram = (studentContext.declaredPrograms ?? []).length > 0;
    const recent = recentHistoryText(history);
    const interestKnown = INTEREST_CUE_RE.test(text) || INTEREST_CUE_RE.test(recent);
    const studyAwayKnown = STUDY_AWAY_RE.test(text) || STUDY_AWAY_RE.test(recent);
    const isPlanning = PLANNING_INTENT_RE.test(lower);
    const isGlobalCampus = GLOBAL_CAMPUSES.has(homeSchool);

    // ---- Signal 1: major/minor exploration with no interest cue ----
    // Checked first: it's the most specific intent and yields the
    // sharpest single follow-up (the student's goal/interest).
    if (MAJOR_EXPLORATION_RE.test(lower) && !interestKnown) {
        signals.push("major_exploration_without_interest");
        topic = "career_interest";
    }

    // ---- Signal 2: forward-planning with no declared program ----
    // Only when we did NOT already decide to ask about interest (one ask).
    if (signals.length === 0 && isPlanning && !hasDeclaredProgram) {
        signals.push("planning_without_declared_program");
        topic = "intended_major";
    }

    // ---- Signal 3: global-campus multi-term plan, no study-away intent ----
    // Only relevant for the two global campuses; fires when the student
    // HAS a direction (program declared) but the away question is open,
    // OR stacks behind signal 2's program ask if neither is known.
    if (
        signals.length === 0
        && isGlobalCampus
        && isPlanning
        && !studyAwayKnown
    ) {
        signals.push("global_campus_planning_without_away_intent");
        topic = "study_away_intent";
    }

    // Bounded by design: at most ONE proactive ask. `shouldElicit` is
    // true iff exactly one signal survived the suppressors above.
    const shouldElicit = signals.length === 1;
    return shouldElicit ? { shouldElicit, signals, topic } : { shouldElicit: false, signals };
}
