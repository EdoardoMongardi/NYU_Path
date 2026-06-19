// ============================================================
// scenarioBadges.ts — shared scenario kind badge helpers
// ============================================================
// Extracted in H4.1 so both ScheduleWorkspace (workspace tab bar)
// and ScheduleCard (chat-thread card) can consume the same labels
// and class names without duplication.
//
// These are pure functions with no React or I/O dependencies.
// ============================================================

export type ScenarioKind = "committed" | "proposed" | "whatif";

/** Human-readable badge label (icon + name). */
export function kindBadgeLabel(kind: ScenarioKind): string {
    switch (kind) {
        case "committed": return "✓ Committed";
        case "proposed":  return "⏳ Proposed";
        case "whatif":    return "🔍 What-if";
    }
}

/** CSS class name to use for the kind badge (plain global class string). */
export function kindBadgeClass(kind: ScenarioKind): string {
    switch (kind) {
        case "committed": return "badge badge-committed";
        case "proposed":  return "badge badge-proposed";
        case "whatif":    return "badge badge-whatif";
    }
}

/** Verdict glyph + readable label + className. */
export function verdictDisplay(verdict: "valid" | "trade-offs" | "invalid"): {
    glyph: string;
    label: string;
    className: string;
} {
    switch (verdict) {
        case "valid":      return { glyph: "✓", label: "Valid", className: "verdict verdict-ok" };
        case "trade-offs": return { glyph: "⚠", label: "Valid with trade-offs", className: "verdict verdict-warn" };
        case "invalid":    return { glyph: "✗", label: "Invalid", className: "verdict verdict-invalid" };
    }
}
