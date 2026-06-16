// ============================================================
// TermCard — single term-bucket card in the sidebar body
// ============================================================
// Phase 17 Task D pre-flight extraction. Owns the term-card JSX:
//   - header (title + credit total)
//   - assumptions / notes list
//   - structural slot list (or Sections-view swap-in)
//   - per-slot rows via <SlotRow>
//   - per-term-card "+ Add course" affordance via <AddCourseAffordance>
//
// All routing logic stays in the parent (`scheduleSidebar.tsx`) —
// TermCard only RECEIVES typed handlers. Phase 4 Task E3.4 removed the
// drag gesture entirely; the per-course ⋯ menu is the sole edit input.
// ============================================================
"use client";

import type { ForwardSchedule, ForwardSemester, ScheduleSlot } from "@nyupath/shared";
import type { TermBucket } from "../../../lib/groupCoursesByTerm";
import type { ForwardMaterializationPayload } from "../../../lib/chatV2Client";
import styles from "../chat.module.css";
import SlotRow from "./SlotRow";
import AddCourseAffordance from "./AddCourseAffordance";
import { renderSectionsView } from "./SectionsView";
// (default-export omitted — TermCard uses the renderer directly inline.)
import { gatherAddCourseSuggestions } from "./slotPopover";
import type { SlotPopoverHandlers } from "./slotPopover";
import { formatTermLabel, slotCredits } from "./sidebarFormatters";

interface TermCardProps {
    bucket: TermBucket;
    semIdx: number;
    forwardSemester: ForwardSemester | undefined;
    schedule: ForwardSchedule | null;
    materialization: ForwardMaterializationPayload | null | undefined;
    /** Whether this card is the first non-locked future term (drives
     *  the Sections-view swap-in for the IMMEDIATE term). */
    isImmediate: boolean;
    /** Phase 17 Task D — set of pin keys ("term::courseId") so SlotRow
     *  can mark a slot as frozen (for the Lock/Unlock toggle). */
    frozenKeys: Set<string>;
    /** Per-slot stable identity key → in-flight Stage-1 spinner. */
    pendingSlots: Set<string>;
    openPopoverKey: string | null;
    openSubmenu: { key: string; verb: "swap" | "move" } | null;
    addCourseDraft: string | undefined;
    selectedComboIdx: number;
    setSelectedComboIdx: (i: number) => void;
    onSlotClick: (key: string, slot: ScheduleSlot) => void;
    onSubmenuToggle: (key: string, verb: "swap" | "move" | null) => void;
    handlers: SlotPopoverHandlers;
    onConfirmCombination?: (proposalId: string) => void;
    onAddCourseOpen: (term: string) => void;
    onAddCourseClose: (term: string) => void;
    onAddCourseChange: (term: string, value: string) => void;
    onAddCourseSubmit: (term: string) => void;
    /** Per-slot stable identity key derivation (drives the spinner Set). */
    slotKeyOf: (slot: ScheduleSlot, term: string) => string;
}

export default function TermCard(props: TermCardProps) {
    const {
        bucket, semIdx, forwardSemester, schedule, materialization,
        isImmediate, frozenKeys, pendingSlots, openPopoverKey, openSubmenu,
        addCourseDraft, selectedComboIdx, setSelectedComboIdx,
        onSlotClick, onSubmenuToggle, handlers, onConfirmCombination,
        onAddCourseOpen, onAddCourseClose, onAddCourseChange, onAddCourseSubmit,
        slotKeyOf,
    } = props;

    const matApplies = isImmediate && !!materialization
        && (
            materialization.targetTerm === bucket.term
            || materialization.semester?.term === bucket.term
        );
    const showSectionsView = matApplies
        && materialization!.state === "full"
        && materialization!.semester !== undefined;
    const showBanner = matApplies
        && (materialization!.state === "partial" || materialization!.state === "unavailable");

    const headerCredits = forwardSemester
        ? forwardSemester.plannedCredits
        : bucket.slots.reduce((sum, s) => sum + (slotCredits(s)), 0);

    // A term card is editable only when NOT locked (history/completed
    // buckets stay read-only).
    const isEditable = !bucket.locked;

    // Phase 17 Task C — Add-course affordance: only on non-locked
    // future term cards (the bucket is non-locked AND has a forward
    // semester entry — we don't add courses to an IP term).
    const showAddCourse = isEditable && !!forwardSemester;

    return (
        <section
            key={bucket.term}
            className={[
                styles.semesterCard,
                bucket.locked ? styles.locked : "",
            ].filter(Boolean).join(" ")}
        >
            <header className={styles.semesterCardHeader}>
                <h3>{formatTermLabel(bucket.term)}</h3>
                <span className={styles.semesterCredits}>{headerCredits} cr</span>
            </header>
            {forwardSemester && forwardSemester.notes.length > 0 && (
                <ul className={styles.semesterNotes}>
                    {forwardSemester.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
            )}
            {showBanner && (
                <div className={styles.materializationBanner}>
                    {materialization!.message}
                </div>
            )}
            {showSectionsView ? (
                renderSectionsView(
                    materialization!,
                    selectedComboIdx,
                    setSelectedComboIdx,
                    onConfirmCombination,
                )
            ) : (
                <ul className={styles.slotList}>
                    {bucket.slots.map((slot, slotIdx) => {
                        const key = `${semIdx}-${slotIdx}`;
                        const isOpen = openPopoverKey === key;
                        const isLocked = slot.kind === "completed";
                        const sKey = slotKeyOf(slot, bucket.term);
                        const isPending = pendingSlots.has(sKey);
                        const isFrozen = frozenKeys.has(sKey);
                        const submenu = openSubmenu && openSubmenu.key === key
                            ? openSubmenu.verb
                            : null;
                        return (
                            <SlotRow
                                key={slotIdx}
                                slot={slot}
                                semIdx={semIdx}
                                slotIdx={slotIdx}
                                bucketTerm={bucket.term}
                                isLocked={isLocked}
                                semesterLocked={bucket.locked}
                                isPending={isPending}
                                isOpen={isOpen}
                                schedule={schedule}
                                isFrozen={isFrozen}
                                submenu={submenu}
                                onSlotClick={() => onSlotClick(key, slot)}
                                onSubmenuToggle={(verb) => onSubmenuToggle(key, verb)}
                                handlers={handlers}
                            />
                        );
                    })}
                </ul>
            )}
            {showAddCourse && (
                <AddCourseAffordance
                    term={bucket.term}
                    schedule={schedule}
                    draft={addCourseDraft}
                    onOpen={onAddCourseOpen}
                    onClose={onAddCourseClose}
                    onChange={onAddCourseChange}
                    onSubmit={onAddCourseSubmit}
                    gatherSuggestions={gatherAddCourseSuggestions}
                />
            )}
        </section>
    );
}
