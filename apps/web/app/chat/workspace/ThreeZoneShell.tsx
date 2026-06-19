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
//   - `right` — the RIGHT-zone JSX: the profile-only `<ProfileRail>`,
//               passed by page.tsx. (Plan 36 H5 cut the right zone over
//               from the old ScheduleSidebar to ProfileRail; Plan 37 G2
//               then DELETED the scheduleSidebar.tsx tree entirely.)
//
// Design constraints:
//   - The right zone is a normal in-flow cell rendering the ProfileRail.
//     (Historically it held a `position: fixed` overlay sidebar drawer;
//     that drawer was unmounted in H5 and removed in Plan 37 G2.)
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
    /** Plan 37 F4 — per-term add-eligibility (window-gated) for the COMMITTED
     *  plan; page.tsx builds it from the committed DPR via @nyupath/engine/client. */
    addTermState?: (term: string) => { allowed: boolean; hedge?: string };
    /** Plan 37 F4 — PROPOSE-ONLY per-term add dispatch for the COMMITTED plan. */
    onAddCourse?: (term: string, courseId: string) => void;
    /** The chat thread + composer (rendered in the LEFT zone). */
    left: ReactNode;
    /** The RIGHT-zone JSX (the profile-only ProfileRail), passed by page.tsx. */
    right: ReactNode;
}

export default function ThreeZoneShell({
    planStore,
    onConfirmProposed,
    onAskWhy,
    slotMatrix,
    onSlotAction,
    addTermState,
    onAddCourse,
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
                    addTermState={addTermState}
                    onAddCourse={onAddCourse}
                />
            </div>
            <div className={styles.zoneRight} data-zone="right">
                {right}
            </div>
        </div>
    );
}
