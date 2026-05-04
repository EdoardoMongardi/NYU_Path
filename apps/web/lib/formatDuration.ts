/**
 * Human-friendly elapsed-time formatter for the agent status UI.
 *   < 1s    → "450ms"
 *   1-9.9s  → "4.7s"   (1 decimal)
 *   10-59s  → "45s"    (rounded to whole second)
 *   ≥ 60s   → "1m 5s"
 */
export function formatDuration(ms: number): string {
    const clamped = Math.max(0, ms);
    if (clamped < 1000) return `${Math.round(clamped)}ms`;
    const s = clamped / 1000;
    // Tier-2 → tier-3 boundary: anything that would round up to "10.0s"
    // belongs in the whole-second tier, not the 1-decimal tier.
    if (s < 9.95) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const mins = Math.floor(s / 60);
    const remaining = Math.round(s - mins * 60);
    // Roll over when rounding pushes the seconds slot to 60 (e.g. 119.5s).
    if (remaining === 60) return `${mins + 1}m 0s`;
    return `${mins}m ${remaining}s`;
}
