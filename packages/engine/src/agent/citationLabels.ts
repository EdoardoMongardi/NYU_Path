/**
 * Maps internal JSON-pointer-style references (e.g.
 * `data/schools/cas.json#f1FullTimeMinCredits`) to user-facing
 * labels. Used by verifiers and tools to keep filesystem paths and
 * config-key names out of student-facing output.
 *
 * The mapping is pattern-based (not a literal table) so a new
 * school config picks up labels automatically: `cas` → "NYU CAS",
 * `stern` → "NYU Stern", `tisch` → "NYU Tisch", etc.
 */

const SCHOOL_DISPLAY_NAMES: Record<string, string> = {
    cas: "NYU CAS",
    stern: "NYU Stern",
    tisch: "NYU Tisch",
    tandon: "NYU Tandon",
    steinhardt: "NYU Steinhardt",
    silver: "NYU Silver",
    gallatin: "NYU Gallatin",
};

const FIELD_DISPLAY_NAMES: Record<string, string> = {
    f1FullTimeMinCredits: "F-1 Full-Time Minimum Credit Policy",
    maxCreditsPerSemester: "Per-Semester Credit Ceiling",
    minGraduationCredits: "Minimum Credits for Graduation",
};

const FALLBACK_LABEL = "NYU policy reference";

const POINTER_RE = /^data\/schools\/([a-z]+)\.json#(\w+)$/;

/**
 * Convert an internal JSON-pointer-style reference to a student-facing label.
 *
 * @param pointer - A string of the form `data/schools/<school>.json#<field>`.
 * @returns A human-readable label, never containing filesystem path characters.
 */
export function formatCitation(pointer: string): string {
    const match = pointer.match(POINTER_RE);
    if (!match) return FALLBACK_LABEL;
    const [, schoolKey, fieldKey] = match;
    const schoolLabel = SCHOOL_DISPLAY_NAMES[schoolKey];
    const fieldLabel = FIELD_DISPLAY_NAMES[fieldKey];
    if (!schoolLabel || !fieldLabel) return FALLBACK_LABEL;
    return `${schoolLabel} ${fieldLabel}`;
}
