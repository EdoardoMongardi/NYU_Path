/**
 * Maps internal JSON-pointer-style references (e.g.
 * `data/schools/cas.json#f1FullTimeMinCredits`) to user-facing
 * labels. Used by verifiers and tools to keep filesystem paths and
 * config-key names out of student-facing output.
 *
 * The mapping is a closed allowlist: each known school and each
 * known field carries an explicit display label. Unknown school
 * keys (e.g. a new config shipped before the dictionary is
 * updated) and unknown field keys gracefully degrade to a partial
 * label or the generic fallback rather than leaking the raw
 * pointer.
 *
 * To add a new school: add a row to `SCHOOL_DISPLAY_NAMES`.
 * To add a new field: add a row to `FIELD_DISPLAY_NAMES`.
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
    // Partial-knowledge fallbacks: prefer the half we know rather
    // than collapsing to the generic phrase. A new school config
    // shipped before the dictionary is updated still surfaces a
    // useful "NYU CAS policy" rather than the opaque generic.
    if (schoolLabel && fieldLabel) return `${schoolLabel} ${fieldLabel}`;
    if (schoolLabel && !fieldLabel) return `${schoolLabel} policy`;
    if (!schoolLabel && fieldLabel) return `NYU ${fieldLabel}`;
    return FALLBACK_LABEL;
}
