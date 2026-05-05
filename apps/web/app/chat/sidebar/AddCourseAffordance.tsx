// ============================================================
// AddCourseAffordance — per-term-card "+ Add course" picker
// ============================================================
// Phase 17 Task C originally inlined this as ~100 LOC of nested
// JSX inside `scheduleSidebar.tsx`'s term-card map. Task D's pre-
// flight refactor extracts it into its own component so the bubble
// + Stage 2 enrichment work doesn't compound the file's
// navigability problem.
//
// Behavior is unchanged from the inline version:
//   - Closed → "+ Add course" pill button.
//   - Click → open inline input + autocomplete suggestions.
//   - Enter / Add button → fires the parent's add handler.
//   - Escape / Cancel → close input.
//   - 2+-char draft surfaces concrete-courseId suggestions
//     filtered from the existing schedule slots (V1 stub; the
//     real /api/v2/search-courses backing lands later).
// ============================================================
"use client";

import type { ForwardSchedule } from "@nyupath/shared";
import styles from "../chat.module.css";

interface AddCourseAffordanceProps {
    term: string;
    schedule: ForwardSchedule | null;
    /** `undefined` = input is closed; string = current draft contents. */
    draft: string | undefined;
    onOpen: (term: string) => void;
    onClose: (term: string) => void;
    onChange: (term: string, value: string) => void;
    onSubmit: (term: string) => void;
    /** Suggestion derivation is parameterized so the sidebar can swap
     *  the V1 client-side prefix-match for a real /api/v2/search-courses
     *  call later without touching this component. */
    gatherSuggestions: (schedule: ForwardSchedule | null, draft: string) => string[];
}

export default function AddCourseAffordance(props: AddCourseAffordanceProps) {
    const { term, schedule, draft, onOpen, onClose, onChange, onSubmit, gatherSuggestions } = props;
    const isOpen = draft !== undefined;
    return (
        <div className={styles.addCourseAffordance}>
            {!isOpen ? (
                <button
                    type="button"
                    className={styles.addCourseButton}
                    onClick={() => onOpen(term)}
                >
                    + Add course
                </button>
            ) : (
                <div className={styles.addCourseInputWrap}>
                    <input
                        type="text"
                        className={styles.addCourseInput}
                        placeholder="e.g. CSCI-UA 480"
                        value={draft ?? ""}
                        autoFocus
                        onChange={(e) => onChange(term, e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") onSubmit(term);
                            if (e.key === "Escape") onClose(term);
                        }}
                    />
                    {(draft ?? "").trim().length >= 2 && (
                        <ul className={styles.addCourseSuggestions}>
                            {gatherSuggestions(schedule, draft ?? "").map((cid) => (
                                <li
                                    key={cid}
                                    className={styles.addCourseSuggestion}
                                    onClick={() => onChange(term, cid)}
                                >
                                    {cid}
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className={styles.addCourseInputRow}>
                        <button
                            type="button"
                            className={styles.addCourseSubmitBtn}
                            disabled={(draft ?? "").trim().length === 0}
                            onClick={() => onSubmit(term)}
                        >
                            Add
                        </button>
                        <button
                            type="button"
                            className={styles.addCourseCancelBtn}
                            onClick={() => onClose(term)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
