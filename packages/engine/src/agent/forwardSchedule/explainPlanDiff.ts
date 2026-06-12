/**
 * Phase 17 Task A — explainPlanDiff template renderer.
 *
 * Pure deterministic string formatting that converts a `(PlanDiff,
 * PlanMutation)` pair into a one-paragraph confirm-bubble template. No
 * LLM, no I/O — every fact in the rendered string comes from the
 * structured diff or the mutation. Used as the fast-path explanation
 * the chat surfaces the instant Stage 1 returns; an optional LLM
 * polish call (Phase 17 Task D) may stream a more natural rewrite
 * later, but the template is the source of truth for accuracy.
 *
 * Each template:
 *  - ≤ 3 sentences.
 *  - Preserves every course code, term, and credit number verbatim.
 *  - Surfaces credit-cap / F-1-floor / requirement / petition deltas
 *    when the structured diff carries them.
 *  - Plain English; no LLM-flavored hedging.
 *
 * The function is exhaustive over `PlanMutation.kind` — TypeScript's
 * `never` guard at the bottom flags any new kind that forgets a
 * template.
 */

import type { PlanDiff, PlanMutation } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a one-paragraph confirm-bubble template for the given
 * `(diff, mutation)` pair. Pure function — same inputs always produce
 * the same string.
 */
export function explainPlanDiff(diff: PlanDiff, mutation: PlanMutation): string {
    switch (mutation.kind) {
        case "pin":      return renderPin(diff, mutation);
        case "exclude":  return renderExclude(diff, mutation);
        case "swap":     return renderSwap(diff, mutation);
        case "move":     return renderMove(diff, mutation);
        case "unpin":    return renderUnpin(diff, mutation);
        case "addTerm":  return renderAddTerm(diff, mutation);
        case "loadStyleOverride": return renderLoadStyleOverride(diff, mutation);
        case "bindFreeElective":  return renderBindFreeElective(diff, mutation);
        case "unbindFreeElective": return renderUnbindFreeElective(diff, mutation);
        case "bindPoolSlot":       return renderBindPoolSlot(diff, mutation);
        case "setSchedulingPreference":   return renderSetSchedulingPreference(diff);
        case "clearSchedulingPreference": return renderClearSchedulingPreference(diff);
        case "addSoftObjective":   return renderAddSoftObjective(diff);
        case "clearSoftObjectives": return renderClearSoftObjectives(diff);
        default: {
            // Exhaustiveness guard — TS will error here if a new kind
            // is added to PlanMutation without a template above.
            const _exhaustive: never = mutation;
            void _exhaustive;
            return "Plan change applied.";
        }
    }
}

// ---------------------------------------------------------------------------
// Per-kind templates
// ---------------------------------------------------------------------------

function renderPin(diff: PlanDiff, m: Extract<PlanMutation, { kind: "pin" }>): string {
    const freeze = m.freeze ?? true;
    const verb = freeze ? "Locking" : "Adding";
    const tail = freeze
        ? "The solver will respect this on every future re-plan."
        : "Placing without a solver lock — future re-plans may move it.";

    const head = `${verb} **${m.courseId}** in **${m.term}**.`;
    const creditNote = renderCreditDelta(diff, m.term);
    const issues = renderIssuesShort(diff);

    if (issues) return `${head} ${creditNote} ${issues}`.replace(/  +/g, " ").trim();
    return `${head} ${creditNote} ${tail}`.replace(/  +/g, " ").trim();
}

function renderExclude(diff: PlanDiff, m: Extract<PlanMutation, { kind: "exclude" }>): string {
    const where = m.term ? ` from **${m.term}**` : "";
    const head = `Dropping **${m.courseId}**${where}.`;

    const newUnmet = diff.newUnmetRequirements.length;
    const gradShift = diff.graduationTermShift;

    if (newUnmet > 0 && gradShift > 0) {
        const reqList = diff.newUnmetRequirements.slice(0, 2).join(", ");
        return `${head} Unmet requirement(s): ${reqList}. Graduation deferred by ${termPlural(gradShift)}.`;
    }
    if (newUnmet > 0) {
        const reqList = diff.newUnmetRequirements.slice(0, 2).join(", ");
        return `${head} Unmet requirement(s): ${reqList}.`;
    }
    if (gradShift > 0) {
        return `${head} Graduation deferred by ${termPlural(gradShift)}.`;
    }
    if (m.term) {
        return `${head} ${renderCreditDeltaOrEmpty(diff, m.term)} No prereq or major-requirement issues.`.replace(/  +/g, " ").trim();
    }
    return `${head} No prereq or major-requirement issues.`;
}

function renderSwap(diff: PlanDiff, m: Extract<PlanMutation, { kind: "swap" }>): string {
    const head = `Swapping **${m.drop}** for **${m.add}** in **${m.term}**.`;
    const credDelta = diff.creditsByTermDelta[m.term] ?? 0;

    const issues = renderIssuesShort(diff);
    if (issues) return `${head} ${issues}`;

    if (credDelta === 0) {
        return `${head} Credit total unchanged.`;
    }
    if (credDelta > 0) {
        return `${head} **${m.term}** climbs by ${credDelta}cr.`;
    }
    return `${head} **${m.term}** drops by ${Math.abs(credDelta)}cr.`;
}

function renderMove(diff: PlanDiff, m: Extract<PlanMutation, { kind: "move" }>): string {
    const head = `Moving **${m.courseId}** from **${m.fromTerm}** to **${m.toTerm}**.`;
    const fromDelta = diff.creditsByTermDelta[m.fromTerm] ?? 0;
    const toDelta = diff.creditsByTermDelta[m.toTerm] ?? 0;

    const parts: string[] = [];
    if (fromDelta !== 0) {
        const dir = fromDelta < 0 ? "drops" : "climbs";
        parts.push(`**${m.fromTerm}** ${dir} by ${Math.abs(fromDelta)}cr`);
    }
    if (toDelta !== 0) {
        const dir = toDelta > 0 ? "climbs" : "drops";
        parts.push(`**${m.toTerm}** ${dir} by ${Math.abs(toDelta)}cr`);
    }

    const issues = renderIssuesShort(diff);
    if (issues) return `${head} ${issues}`;

    if (parts.length > 0) {
        return `${head} ${parts.join("; ")}.`;
    }
    return `${head} Credit totals unchanged.`;
}

function renderUnpin(diff: PlanDiff, m: Extract<PlanMutation, { kind: "unpin" }>): string {
    const head = `Unlocking **${m.courseId}** in **${m.term}**.`;
    const issues = renderIssuesShort(diff);
    if (issues) return `${head} ${issues}`;
    return `${head} The solver may re-place it on the next re-plan.`;
}

function renderAddTerm(diff: PlanDiff, m: Extract<PlanMutation, { kind: "addTerm" }>): string {
    const head = `Adding **${m.term}** to the planning window.`;
    const gradShift = diff.graduationTermShift;
    if (gradShift > 0) {
        return `${head} Graduation pushed back by ${termPlural(gradShift)}.`;
    }
    if (gradShift < 0) {
        return `${head} Graduation pulled in by ${termPlural(Math.abs(gradShift))}.`;
    }
    return `${head} Graduation timeline unchanged.`;
}

function renderLoadStyleOverride(diff: PlanDiff, m: Extract<PlanMutation, { kind: "loadStyleOverride" }>): string {
    const where = m.term ? ` for **${m.term}**` : "";
    const head = `Setting load style to **${m.style}**${where}.`;
    const bi = diff.balanceImpact;
    if (bi.classification === "improved") {
        return `${head} Balance improves (${bi.before.toFixed(2)} → ${bi.after.toFixed(2)}).`;
    }
    if (bi.classification === "degraded-mild" || bi.classification === "degraded-significant") {
        return `${head} Balance worsens (${bi.before.toFixed(2)} → ${bi.after.toFixed(2)}).`;
    }
    return `${head} Balance impact: negligible.`;
}

function renderBindFreeElective(_diff: PlanDiff, m: Extract<PlanMutation, { kind: "bindFreeElective" }>): string {
    return `Binding **${m.courseId}** to free-elective slot **${m.slotId}**.`;
}

function renderUnbindFreeElective(_diff: PlanDiff, m: Extract<PlanMutation, { kind: "unbindFreeElective" }>): string {
    return `Unbinding free-elective slot **${m.slotId}** — the slot returns to its placeholder state.`;
}

function renderBindPoolSlot(_diff: PlanDiff, m: Extract<PlanMutation, { kind: "bindPoolSlot" }>): string {
    return `Binding **${m.courseId}** to pool slot **${m.slotId}**.`;
}

function renderSetSchedulingPreference(_diff: PlanDiff): string {
    return "Updating scheduling preferences (time/day filters). Section selection in the immediate term will respect the new filters.";
}

function renderClearSchedulingPreference(_diff: PlanDiff): string {
    return "Clearing scheduling preferences (time/day filters). All sections become eligible again.";
}

function renderAddSoftObjective(_diff: PlanDiff): string {
    // D6.2 — rung-2 SOFT objective: recorded and used only to bias which VALID
    // plan ranks first; it never changes feasibility or validity.
    return "Recorded a soft scheduling preference (applies when ranking equally-valid plans).";
}

function renderClearSoftObjectives(_diff: PlanDiff): string {
    return "Cleared the recorded soft scheduling preferences.";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCreditDelta(diff: PlanDiff, term: string): string {
    const delta = diff.creditsByTermDelta[term] ?? 0;
    if (delta === 0) {
        return `Credit total for **${term}** unchanged.`;
    }
    if (delta > 0) {
        return `**${term}** climbs by ${delta}cr.`;
    }
    return `**${term}** drops by ${Math.abs(delta)}cr.`;
}

function renderCreditDeltaOrEmpty(diff: PlanDiff, term: string): string {
    const delta = diff.creditsByTermDelta[term] ?? 0;
    if (delta === 0) return "";
    if (delta > 0) return `**${term}** climbs by ${delta}cr.`;
    return `**${term}** drops by ${Math.abs(delta)}cr.`;
}

/**
 * Render the most-important issues in one sentence, or `""` if none.
 * Priority: planState change → new unmet requirements → graduation
 * shift → newRequiresPetition → fall-through.
 */
function renderIssuesShort(diff: PlanDiff): string {
    const psc = diff.planStateChange;
    if (psc && (psc.to === "infeasible-draft" || psc.to === "student-preferred-invalid-draft")) {
        return `Plan flips to **${psc.to}** state — review carefully before confirming.`;
    }
    if (diff.newUnmetRequirements.length > 0) {
        const reqList = diff.newUnmetRequirements.slice(0, 2).join(", ");
        return `New unmet requirement(s): ${reqList}.`;
    }
    if (diff.graduationTermShift > 0) {
        return `Graduation deferred by ${termPlural(diff.graduationTermShift)}.`;
    }
    if (diff.newRequiresPetition.length > 0) {
        const petList = diff.newRequiresPetition.slice(0, 2).join(", ");
        return `New petition required: ${petList}.`;
    }
    return "";
}

function termPlural(n: number): string {
    return n === 1 ? "1 term" : `${n} terms`;
}
