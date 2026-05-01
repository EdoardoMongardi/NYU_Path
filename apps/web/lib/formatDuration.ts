/**
 * Human-friendly elapsed-time formatter for the agent status UI.
 *   < 1s   → "450ms"
 *   1-10s  → "4.7s"   (1 decimal)
 *   10-60s → "45s"    (rounded to whole second)
 *   ≥ 60s  → "1m 5s"
 */
export function formatDuration(ms: number): string {
    const clamped = Math.max(0, ms);
    if (clamped < 1000) return `${Math.round(clamped)}ms`;
    const s = clamped / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const mins = Math.floor(s / 60);
    const remaining = Math.round(s - mins * 60);
    return `${mins}m ${remaining}s`;
}
