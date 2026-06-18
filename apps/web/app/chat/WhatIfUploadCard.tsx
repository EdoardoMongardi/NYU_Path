// ============================================================
// WhatIfUploadCard — H4.2b-3 (plan 36 scenarios workspace UI)
// ============================================================
// A chat-thread card the assistant emits when the agent offers a
// Branch-A "explore precisely" path: upload your Albert What-If audit
// for a HYPOTHETICAL PROGRAM and we'll compute the exact hypothetical
// plan (a READ-ONLY 🔍 what-if scenario — never committed).
//
// Design references:
//   Docs/mockups/scenarios-ui-mockup.html — the chat .card styling
//   Docs/plans/36-*.md §7 H4.2b           — spec
//
// PRESENTATIONAL ONLY — no store reads, no fetch. The page owns the
// upload round-trip (handleWhatIfAuditUpload) + per-card busy/error
// state and passes them in as props.
// ============================================================

"use client";

import { useRef, type JSX } from "react";
import styles from "./chat.module.css";

// ============================================================
// Props
// ============================================================

export interface WhatIfUploadCardProps {
    /** The hypothetical program the agent offered to explore. */
    hypotheticalProgram: string;
    /** Called with the chosen PDF File when the student picks one. */
    onUpload: (file: File) => void;
    /** True while an upload is in flight — disables the button + shows a spinner. */
    uploading?: boolean;
    /** Error text to show below the button (e.g. parse/network failure). */
    error?: string;
}

// ============================================================
// Component
// ============================================================

export default function WhatIfUploadCard({
    hypotheticalProgram,
    onUpload,
    uploading,
    error,
}: WhatIfUploadCardProps): JSX.Element {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const openPicker = (): void => {
        fileInputRef.current?.click();
    };

    const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
        const file = e.target.files?.[0];
        // Reset the input value so re-picking the SAME file fires onChange again.
        e.target.value = "";
        if (file) onUpload(file);
    };

    return (
        <div className={styles.whatifUploadCard} data-kind="whatif_upload_card">
            <p className={styles.whatifUploadHeading}>Explore precisely</p>
            <p className={styles.whatifUploadBody}>
                Upload your Albert What-If audit for{" "}
                <strong>{hypotheticalProgram}</strong> to see an exact
                hypothetical plan. It stays a read-only exploration — not your
                committed plan.
            </p>

            <button
                type="button"
                className={styles.whatifUploadBtn}
                onClick={openPicker}
                disabled={!!uploading}
                aria-label={`Upload Albert What-If audit for ${hypotheticalProgram}`}
            >
                {uploading ? (
                    <>
                        <span
                            className={styles.whatifUploadSpinner}
                            role="status"
                            aria-label="Uploading"
                            data-testid="whatif-upload-spinner"
                        />
                        Uploading…
                    </>
                ) : (
                    "Upload What-If audit (PDF)"
                )}
            </button>

            {/* Hidden file input — PDF only, opened by the button. */}
            <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                style={{ display: "none" }}
                onChange={onChange}
                data-testid="whatif-upload-input"
            />

            {error !== undefined && error.length > 0 && (
                <p className={styles.whatifUploadError} role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
