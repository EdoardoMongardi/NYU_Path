/**
 * Phase 13 — Visa-aware credit-target + per-term notes.
 *
 * - F-1 floor: 12 credits per main term (school-config-derived; default 12).
 *   Below this without OGS-approved RCL: visa status is at risk.
 * - Domestic part-time floor: 8 credits (school-config-derived; default 8).
 *   Below this: not registered for any standing.
 * - Domestic full-time threshold: typically 12 (school-config or
 *   f1Floor as proxy). Between part-time floor and full-time: part-time
 *   notice + financial-aid implications.
 */

interface VisaContext {
    credits: number;
    visa: string | undefined;
    f1Floor: number | null;
    domesticPartTimeFloor: number | null;
}

export function creditTargetForVisa(visa: string | undefined): number {
    if (visa === "f1") return 12;
    return 16;
}

export function visaNotesForCredits(ctx: VisaContext): string[] {
    const notes: string[] = [];
    if (ctx.visa === "f1" && ctx.f1Floor != null && ctx.credits < ctx.f1Floor) {
        notes.push(
            `Below F-1 full-time floor of ${ctx.f1Floor} credits — Reduced Course Load (RCL) approval from NYU OGS required before registration.`
        );
    }
    if (ctx.visa !== "f1" && ctx.f1Floor != null && ctx.domesticPartTimeFloor != null) {
        if (ctx.credits >= ctx.domesticPartTimeFloor && ctx.credits < ctx.f1Floor) {
            notes.push(
                `Part-time enrollment (${ctx.credits} credits, below ${ctx.f1Floor}-credit full-time threshold). Confirm financial-aid impact with the bursar.`
            );
        }
        if (ctx.credits < ctx.domesticPartTimeFloor) {
            notes.push(
                `Below ${ctx.domesticPartTimeFloor}-credit minimum enrollment — student would not be registered for standing.`
            );
        }
    }
    return notes;
}
