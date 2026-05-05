// ============================================================
// sidebarFormatters — string formatting helpers for the sidebar
// ============================================================
// Phase 17 Task D pre-flight extraction. Pulled out of
// `scheduleSidebar.tsx` so subcomponents can format term labels /
// visa strings without re-importing the whole sidebar module.
// ============================================================

import type { Assumption, ScheduleSlot } from "@nyupath/shared";

export function formatVisa(visaStatus?: "f1" | "domestic" | "other"): string {
    switch (visaStatus) {
        case "f1": return "F-1";
        case "domestic": return "Domestic";
        case "other": return "Other";
        default: return "";
    }
}

export function formatTermLabel(term: string): string {
    const m = term.match(/^(\d{4})-(spring|summer|fall|january)$/i);
    if (!m) return term;
    const season = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1).toLowerCase();
    return `${season} ${m[1]}`;
}

export function assumptionLabel(a: Assumption): string {
    switch (a.type) {
        case "IP_COURSE_COMPLETION":
            return `Assumes ${a.courseId} completes successfully`;
        case "LLM_RANKED_ALTERNATIVE":
            return a.reasoning.slice(0, 120);
        case "HEURISTIC_MAPPING":
            return a.reasoning.slice(0, 120);
    }
}

/** Slot-level credit accessor used to compute a per-bucket header
 *  total when the bucket has no matching ForwardSemester (history /
 *  IP cards). All four slot kinds carry `credits` directly. */
export function slotCredits(slot: ScheduleSlot): number {
    return slot.credits;
}
