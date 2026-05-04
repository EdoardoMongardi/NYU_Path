// ============================================================
// formatMeetingPatterns — Phase 15 Task 8
// ============================================================
// Pure helpers used by `app/chat/scheduleSidebar.tsx` to render the
// Sections view's per-course meeting times. Lives outside the .tsx
// component so vitest (which only runs .test.ts under apps/web/tests/)
// can exercise them in isolation.
// ============================================================

import type { MeetingPattern } from "@nyupath/shared";

/**
 * Format minutes-since-midnight as a compact 12h-clock label, e.g.
 * `570` → `"9:30a"`, `780` → `"1p"`, `0` → `"12a"`. Trailing `:00` is
 * dropped to keep the meeting-pattern strings readable in the narrow
 * sidebar column.
 */
export function formatHmm(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    const ampm = h < 12 ? "a" : "p";
    const h12 = ((h + 11) % 12) + 1;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, "0")}${ampm}`;
}

/**
 * Format a list of weekly meeting patterns as a single human-readable
 * line, e.g. `[{day:"Tu",480,555},{day:"Th",480,555}]` →
 * `"Tu 8a–9:15a · Th 8a–9:15a"`. Empty list returns `"Asynchronous"`,
 * matching the semantics of `SectionView.isAsynchronous`.
 */
export function formatPatterns(patterns: MeetingPattern[]): string {
    if (patterns.length === 0) return "Asynchronous";
    return patterns
        .map(p => `${p.day} ${formatHmm(p.startMin)}–${formatHmm(p.endMin)}`)
        .join(" · ");
}
