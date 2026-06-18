// ============================================================
// slotPopover — 4-verb slot popover renderer + submenus
// ============================================================
// Phase 17 Task D pre-flight extraction. Owns:
//   - the SLOT_VERBS constant + verb labels
//   - the popover JSX (verb buttons + submenu containers)
//   - the Swap submenu (alternatives + free-text search)
//   - the Move submenu (eligible target terms)
//   - the small client-side helpers that derive Swap candidates
//     and Move target terms from the forward schedule
//
// All click handlers are passed in via `SlotPopoverHandlers` so this
// module never touches the planActionClient directly.
// ============================================================
"use client";

import { useState } from "react";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import styles from "../chat.module.css";
import type { SlotIpChangeability } from "./slotState";
import { whatIfSlotControl, type WhatIfOption } from "../../../lib/whatIfSlotControl";

type SlotVerb = "swap" | "drop" | "lock" | "move" | "explain";

const SLOT_VERBS: Array<{ verb: SlotVerb; label: string; submenu: boolean }> = [
    { verb: "swap", label: "Swap with…", submenu: true },
    { verb: "drop", label: "Drop", submenu: false },
    { verb: "lock", label: "Lock / Unlock", submenu: false },
    { verb: "move", label: "Move to…", submenu: true },
    // Phase 4 Task E4.1 — "Explain why" injects a SCOPED chat question
    // (course code + human term label) into the normal agent loop. No
    // submenu; fires `onExplain` directly.
    { verb: "explain", label: "Explain why", submenu: false },
];

export interface SlotPopoverHandlers {
    onSwap: (slot: ScheduleSlot, term: string, candidateCourseId: string) => Promise<void>;
    onMove: (slot: ScheduleSlot, fromTerm: string, toTerm: string) => Promise<void>;
    onDrop: (slot: ScheduleSlot, term: string) => Promise<void>;
    onLock: (slot: ScheduleSlot, term: string) => Promise<void>;
    /** Phase 4 Task E4.1 — inject a scoped "Explain why" chat question. */
    onExplain: (slot: ScheduleSlot, term: string) => void;
    /** G3.2 — propose a what-if assumption (W/P-F) for a current-term IP course.
     *  Only called when the F3 window permits it (whatIfSlotControl gates this). */
    onWhatIf?: (slot: ScheduleSlot, term: string, outcome: "withdraw" | "pass" | "fail") => Promise<void>;
}

interface RenderSlotPopoverArgs {
    slot: ScheduleSlot;
    term: string;
    /** Phase 17 Task D — drives the Lock/Unlock label inside the
     *  popover. `true` → "Unlock"; `false` → "Lock". */
    isFrozen: boolean;
    submenu: "swap" | "move" | null;
    onSubmenuToggle: (verb: "swap" | "move" | null) => void;
    schedule: ForwardSchedule | null;
    handlers: SlotPopoverHandlers;
    /** G3.2 — F3 IP changeability classification for this slot. When present
     *  and the slot is `in_progress`, the popover offers what-if controls
     *  (or a grounded hedge when the window is closed). When absent, no
     *  what-if section is rendered. */
    ipChangeability?: SlotIpChangeability;
}

export function renderSlotPopover(args: RenderSlotPopoverArgs) {
    const { slot, term, submenu, onSubmenuToggle, schedule, handlers, isFrozen, ipChangeability } = args;

    // G3.2 — derive the what-if control section for in_progress slots. The
    // pure `whatIfSlotControl` helper gates this on the F3 window; the
    // React render below is a thin consumer.
    const whatIfView = slot.kind === "in_progress"
        ? whatIfSlotControl(ipChangeability)
        : null;

    return (
        <div className={styles.slotPopover} onClick={(e) => e.stopPropagation()}>
            {SLOT_VERBS.map((v) => (
                <button
                    key={v.verb}
                    type="button"
                    onClick={() => {
                        if (v.verb === "swap" || v.verb === "move") {
                            if (submenu === v.verb) onSubmenuToggle(null);
                            else onSubmenuToggle(v.verb);
                            return;
                        }
                        if (v.verb === "drop") void handlers.onDrop(slot, term);
                        else if (v.verb === "lock") void handlers.onLock(slot, term);
                        else if (v.verb === "explain") handlers.onExplain(slot, term);
                    }}
                >
                    {v.verb === "lock" ? (isFrozen ? "Unlock" : "Lock") : v.label}
                </button>
            ))}
            {submenu === "swap" && renderSwapSubmenu(slot, term, schedule, handlers.onSwap)}
            {submenu === "move" && renderMoveSubmenu(slot, term, schedule, handlers.onMove)}

            {/* G3.2 — what-if assumption section (F3-gated; only for in_progress
                slots). When the F3 window permits, offer Withdraw / Pass-fail
                options that POST to /api/plan/whatif. When the window is closed or
                unknown, show a grounded hedge instead of an actionable control.
                CRITICAL: when onWhatIf is not wired, the section is suppressed
                entirely (the parent component opts in by providing the handler). */}
            {whatIfView && handlers.onWhatIf && (
                <div className={styles.slotPopoverWhatIf}>
                    <div className={styles.slotPopoverSubmenuHeading}>
                        What-if (unverified assumption)
                    </div>
                    {whatIfView.offer ? (
                        whatIfView.options.map((opt: WhatIfOption) => (
                            <button
                                key={opt.outcome}
                                type="button"
                                className={styles.slotPopoverWhatIfBtn}
                                title={`Record as assumption — not a fact. Confirm records a plan under this assumption; your DPR is never changed.`}
                                onClick={() => void handlers.onWhatIf!(slot, term, opt.outcome)}
                            >
                                {opt.label}
                            </button>
                        ))
                    ) : whatIfView.hedge ? (
                        <p className={styles.slotPopoverWhatIfHedge}>{whatIfView.hedge}</p>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function renderSwapSubmenu(
    slot: ScheduleSlot,
    term: string,
    schedule: ForwardSchedule | null,
    onSwap: SlotPopoverHandlers["onSwap"],
) {
    const alternatives = gatherSwapAlternatives(slot, term, schedule);
    return (
        <div className={`${styles.slotPopoverSubmenu} ${styles.swapSubmenu}`}>
            {alternatives.length > 0 && (
                <>
                    <div className={styles.slotPopoverSubmenuHeading}>Alternatives</div>
                    {alternatives.map((alt) => (
                        <button
                            key={alt}
                            type="button"
                            onClick={() => void onSwap(slot, term, alt)}
                        >
                            {alt}
                        </button>
                    ))}
                </>
            )}
            <div className={styles.slotPopoverSubmenuHeading}>Or search…</div>
            <SwapFreeSearch slot={slot} term={term} onSwap={onSwap} />
        </div>
    );
}

function SwapFreeSearch(props: {
    slot: ScheduleSlot;
    term: string;
    onSwap: SlotPopoverHandlers["onSwap"];
}) {
    const [value, setValue] = useState("");
    return (
        <div className={styles.addCourseInputWrap}>
            <input
                type="text"
                className={styles.addCourseInput}
                placeholder="e.g. CSCI-UA 480"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && value.trim().length > 0) {
                        void props.onSwap(props.slot, props.term, value.trim());
                    }
                }}
            />
            <div className={styles.addCourseInputRow}>
                <button
                    type="button"
                    className={styles.addCourseSubmitBtn}
                    disabled={value.trim().length === 0}
                    onClick={() => void props.onSwap(props.slot, props.term, value.trim())}
                >
                    Swap
                </button>
            </div>
        </div>
    );
}

function renderMoveSubmenu(
    slot: ScheduleSlot,
    term: string,
    schedule: ForwardSchedule | null,
    onMove: SlotPopoverHandlers["onMove"],
) {
    const targets = gatherMoveTargets(term, schedule);
    if (targets.length === 0) {
        return (
            <div className={`${styles.slotPopoverSubmenu} ${styles.moveSubmenu}`}>
                <div className={styles.slotPopoverSubmenuHeading}>No eligible terms</div>
            </div>
        );
    }
    return (
        <div className={`${styles.slotPopoverSubmenu} ${styles.moveSubmenu}`}>
            <div className={styles.slotPopoverSubmenuHeading}>Move to…</div>
            {targets.map((t) => (
                <button
                    key={t}
                    type="button"
                    onClick={() => void onMove(slot, term, t)}
                >
                    {formatTermLabel(t)}
                </button>
            ))}
        </div>
    );
}

/**
 * Phase 17 Task C — derive Swap candidate course IDs from the forward
 * schedule. Collects course IDs that share at least one entry in
 * `satisfiesRules` with the source slot. Falls back to "other slots in
 * the same term" when the slot lacks rules (history / IP slots).
 */
function gatherSwapAlternatives(
    slot: ScheduleSlot,
    term: string,
    schedule: ForwardSchedule | null,
): string[] {
    if (!schedule) return [];
    const rules = (slot.kind === "specific_planned" || slot.kind === "placeholder")
        ? new Set(slot.satisfiesRules)
        : null;
    const ownId = (slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress")
        ? slot.courseId
        : null;
    const out = new Set<string>();
    for (const sem of schedule.semesters) {
        for (const s of sem.slots) {
            if (s === slot) continue;
            const cid =
                s.kind === "specific_planned" || s.kind === "completed" || s.kind === "in_progress"
                    ? s.courseId
                    : null;
            if (!cid) continue;
            if (cid === ownId) continue;
            if (rules && rules.size > 0) {
                const sRules = (s.kind === "specific_planned" || s.kind === "placeholder")
                    ? s.satisfiesRules
                    : [];
                if (!sRules.some((r) => rules.has(r))) continue;
            } else {
                if (sem.term !== term) continue;
            }
            out.add(cid);
        }
    }
    return Array.from(out).slice(0, 5);
}

function gatherMoveTargets(sourceTerm: string, schedule: ForwardSchedule | null): string[] {
    if (!schedule) return [];
    const out: string[] = [];
    for (const sem of schedule.semesters) {
        if (sem.locked) continue;
        if (sem.term === sourceTerm) continue;
        out.push(sem.term);
    }
    return out;
}

/**
 * Phase 17 Task C — V1 Add-course autocomplete. Surface concrete
 * course IDs from the forward schedule that match the draft as a
 * prefix (case-insensitive). Used by the AddCourseAffordance
 * suggestion list.
 */
export function gatherAddCourseSuggestions(
    schedule: ForwardSchedule | null,
    draft: string,
): string[] {
    const q = draft.trim().toUpperCase();
    if (q.length < 2 || !schedule) return [];
    const out = new Set<string>();
    for (const sem of schedule.semesters) {
        for (const s of sem.slots) {
            const cid =
                s.kind === "specific_planned" || s.kind === "completed" || s.kind === "in_progress"
                    ? s.courseId
                    : null;
            if (!cid) continue;
            if (cid.toUpperCase().startsWith(q)) out.add(cid);
        }
    }
    return Array.from(out).slice(0, 5);
}

function formatTermLabel(term: string): string {
    const m = term.match(/^(\d{4})-(spring|summer|fall|january)$/i);
    if (!m) return term;
    const season = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1).toLowerCase();
    return `${season} ${m[1]}`;
}
