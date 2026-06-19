// ============================================================
// slotTier — workload-tier left-border tint helper
// ============================================================
// Phase 17 Task D pre-flight extraction. Returns the CSS-module class
// for the slot's `workloadTier`, or `undefined` for slot kinds that
// don't carry a tier (history `completed` rows + IP `in_progress`).
//
// Tier strings come from `WorkloadTier` in
// `packages/shared/src/types.ts`. CSS-module class names mirror the
// keys (`.slotTier_major-required` etc.).
// ============================================================
import type { ScheduleSlot } from "@nyupath/shared";
import styles from "../chat.module.css";

export function slotTierClassName(slot: ScheduleSlot): string | undefined {
    if (slot.kind !== "specific_planned" && slot.kind !== "placeholder") return undefined;
    const cls = styles[`slotTier_${slot.workloadTier}`];
    return cls || undefined;
}
