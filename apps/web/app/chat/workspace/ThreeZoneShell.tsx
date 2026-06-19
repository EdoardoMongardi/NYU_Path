// ============================================================
// ThreeZoneShell — H2.1 (plan 36 scenarios workspace UI)
// ============================================================
// The 3-zone chat layout shell:
//
//   ┌──────────────┬──────────────────────┬────────────────┐
//   │  chat (LEFT) │  ScheduleWorkspace   │  sidebar       │
//   │  thread +    │  (CENTER)            │  (RIGHT)       │
//   │  composer    │  tabs + scenarios    │  existing      │
//   └──────────────┴──────────────────────┴────────────────┘
//
// page.tsx is a heavy client component (SSE, localStorage,
// useMemo(createPlanStore), many hooks). Rather than thread the new
// CENTER zone through that file's render tree by hand (and to keep a
// jsdom-mountable unit for the H2.1 render test), the presentational
// shell lives here as a THIN component:
//   - `left`  — the chat thread + composer JSX (passed by page.tsx).
//   - center  — `<ScheduleWorkspace>` (mounted here), fed the SAME
//               shared `planStore` page.tsx already uses + the two
//               callbacks (Confirm / Ask-why) wired to page.tsx's
//               existing confirm round-trip and chat injection.
//   - `right` — the existing `<ScheduleSidebar>` JSX (passed by
//               page.tsx UNCHANGED). H5 will repurpose it into a
//               profile-only rail; for now it is mounted as-is and is
//               redundant with the workspace.
//
// Design constraints:
//   - ADDITIVE: this does NOT change ScheduleSidebar's props/behavior.
//     The sidebar is a `position: fixed` overlay drawer that returns
//     null when closed, so it still floats over the RIGHT cell exactly
//     as it does today — the cell is a layout placeholder until H5.
//   - The full visual pass is H6; the grid here is functional.
//   - This is web-only / desktop (≥1100px). No mobile breakpoint.
// ============================================================
"use client";

import type { ReactElement, ReactNode } from "react";
import type { ScheduleSlot } from "@nyupath/shared";
import type { SlotAction, SlotActionMatrix } from "@nyupath/engine";
import type { PlanStore, Scenario } from "../planState";
import styles from "../chat.module.css";
import ScheduleWorkspace from "./ScheduleWorkspace";

export interface ThreeZoneShellProps {
    /** The shared plan store (the SAME instance page.tsx already holds). */
    planStore: PlanStore;
    /** Wired to page.tsx's existing confirm round-trip (planConfirm). */
    onConfirmProposed: (scenario: Scenario) => void;
    /** Wired to page.tsx's existing "Ask why" chat injection. */
    onAskWhy: (scenario: Scenario) => void;
    /** Plan 37 F3 — slot-action matrix builder for the COMMITTED plan (page.tsx
     *  builds it from the committed DPR via @nyupath/engine/client). */
    slotMatrix?: (slot: ScheduleSlot, term: string) => SlotActionMatrix;
    /** Plan 37 F3 — PROPOSE-ONLY per-slot dispatch for the COMMITTED plan. */
    onSlotAction?: (slot: ScheduleSlot, term: string, action: SlotAction) => void;
    /** The chat thread + composer (rendered in the LEFT zone). */
    left: ReactNode;
    /** The existing ScheduleSidebar (rendered in the RIGHT zone, unchanged). */
    right: ReactNode;
}

export default function ThreeZoneShell({
    planStore,
    onConfirmProposed,
    onAskWhy,
    slotMatrix,
    onSlotAction,
    left,
    right,
}: ThreeZoneShellProps): ReactElement {
    return (
        <div className={styles.threeZone}>
            <div className={styles.zoneLeft} data-zone="left">
                {left}
            </div>
            <div className={styles.zoneCenter} data-zone="center">
                <ScheduleWorkspace
                    planStore={planStore}
                    onConfirmProposed={onConfirmProposed}
                    onAskWhy={onAskWhy}
                    slotMatrix={slotMatrix}
                    onSlotAction={onSlotAction}
                />
            </div>
            <div className={styles.zoneRight} data-zone="right">
                {right}
            </div>
        </div>
    );
}
