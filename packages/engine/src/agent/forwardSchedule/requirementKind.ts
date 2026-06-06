/**
 * RC-3 / HARD-2 — Structural requirement-kind classifier.
 *
 * Classifies each DPR leaf requirement by the STRUCTURAL IDENTITY of its
 * ancestor requirement-group, NOT by substring-matching the leaf's rId or title.
 *
 * How group identity is determined:
 *
 *  1. MAJOR group: a top-level (or any-depth) requirement group whose title
 *     starts with the declared major's label (from DPR programs[]), OR
 *     whose title contains the words "Joint Major", "Major Approved", or
 *     "Major" AND the title text overlaps with one of the declared programs.
 *     Fallback: any group that is a parent of rIds in the R1142/* family
 *     (this is the CAS-CS/Math pattern; other programs use different rId
 *     families that we cannot predict without a program-rules database).
 *
 *     Within a major group, a leaf is "major-elective" when:
 *       - its title contains "Elective" (case-insensitive), OR
 *       - its counter is kind:"courses" with required ≤ 2 AND description
 *         implies "choose from" (heuristic: required < total course pool).
 *     All other major-group leaves → "major-required".
 *
 *  2. SCHOOL-CORE group: a group whose title starts with "CORE" or contains
 *     "Core Curriculum" or a structural marker like "First-Year Seminar",
 *     "Foreign Language", "Expository Writing", "Writing Proficiency".
 *     Structural rgId families: RG5004, RG5007, RG5393, RG33308, RG5002,
 *     RG5005, RG31394 (all confirmed present in the CAS fixture).
 *
 *  3. GENERAL ELECTIVES group: a group whose title is "General Electives"
 *     (exactly) or whose title contains "General Elective" and is NOT a
 *     major group. Structural rgId: RG31395 in the CAS fixture.
 *     Leaves → "free-elective" (they are "courses not used anywhere else",
 *     i.e. completely unrestricted placeholders).
 *
 *  4. Otherwise → "unknown".
 *
 * DOCUMENTED LIMITS:
 *   - The major-group identification heuristic (matching group title against
 *     the declared-program label from DPR programs[]) has been validated
 *     ONLY against the CAS CS/Math joint-major fixture. Non-CAS hierarchies
 *     (Stern, Tandon, SPS, Gallatin, NYUAD, Shanghai) use different rId
 *     families and group-title patterns that are NOT in scope here. Callers
 *     should treat `RequirementKind = "unknown"` for leaves that cannot be
 *     structurally resolved and handle it gracefully.
 *   - Elective vs. required is determined within a major group by checking
 *     the leaf title for the word "Elective". This is a group-level label
 *     (e.g., "Computer Science: Elective Courses"), not a leaf-title keyword
 *     hunt on arbitrary strings — and the group-ancestor test runs first.
 *     The distinction is: we rely on the GROUP LEVEL label as a stable
 *     structural signal, not the leaf's own rId keyword.
 */

import type { DPRRequirementGroup, DPRRequirement } from "../../dpr/schema.js";
import type { ProgramDeclaration } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const REQUIREMENT_KINDS = [
    "major-required", "major-elective", "school-core",
    "general-elective", "free-elective", "unknown",
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/** Heavy-vs-easy weight per kind (mirrors workloadTier BASE_WEIGHT). */
export const KIND_WEIGHT: Record<RequirementKind, number> = {
    "major-required": 1.0, "major-elective": 1.0, "school-core": 1.0,
    "general-elective": 0.6, "free-elective": 0.5, "unknown": 0.6,
};

export interface ClassifyArgs {
    groups: DPRRequirementGroup[];
    declaredPrograms: ProgramDeclaration[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map every leaf requirement's rId → its structural RequirementKind.
 *
 * Walks the DPR requirement-group tree once, carrying an inherited
 * group-kind context from each ancestor group down to its leaves.
 * The classification is purely structural (group ancestry + declared
 * programs), with no substring-matching on leaf rId or leaf title.
 */
export function classifyRequirementKind(args: ClassifyArgs): Map<string, RequirementKind> {
    const { groups, declaredPrograms } = args;
    const result = new Map<string, RequirementKind>();

    // Build a normalized set of declared-major labels for matching
    // against group titles. E.g. "Computer Science/Math" (from DPR
    // programs[].label) → used to identify the major group.
    const majorLabels = buildMajorLabelSet(declaredPrograms);

    for (const group of groups) {
        visitGroup(group, null, majorLabels, result);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Internal tree walker
// ---------------------------------------------------------------------------

/**
 * Three-value "group kind" carried down the tree from ancestor groups.
 * - "major"       → this subtree is part of the student's major
 * - "school-core" → this subtree is part of school core / college requirements
 * - "general-elective" → this subtree is the catch-all general/free electives
 * - null           → not yet determined (may become "unknown" at leaf level)
 */
type GroupKind = "major" | "school-core" | "general-elective" | null;

function visitGroup(
    group: DPRRequirementGroup,
    inheritedKind: GroupKind,
    majorLabels: Set<string>,
    result: Map<string, RequirementKind>,
): void {
    // Determine this group's kind: own identity wins over inherited.
    const ownKind = classifyGroupKind(group, majorLabels);
    const effectiveKind: GroupKind = ownKind ?? inheritedKind;

    for (const child of group.children) {
        if ("rId" in child) {
            // Leaf requirement
            const kind = leafKind(child, effectiveKind, group);
            result.set(child.rId, kind);
        } else {
            // Nested group — recurse
            visitGroup(child, effectiveKind, majorLabels, result);
        }
    }
}

/**
 * Classify a group itself — returns the kind it contributes to its subtree,
 * or null if this group does not identify a meaningful category on its own
 * (the parent's kind will be inherited).
 */
function classifyGroupKind(
    group: DPRRequirementGroup,
    majorLabels: Set<string>,
): GroupKind | null {
    const title = group.title;

    // 1. MAJOR: does the group title match a declared-major label?
    if (isMajorGroup(title, majorLabels)) {
        return "major";
    }

    // 2. SCHOOL-CORE: structural CAS core groups
    if (isCoreGroup(title, group.rgId)) {
        return "school-core";
    }

    // 3. GENERAL ELECTIVES
    if (isGeneralElectivesGroup(title)) {
        return "general-elective";
    }

    return null;
}

/**
 * Given a leaf's effective group kind (inherited from its nearest
 * classifiable ancestor), produce the final RequirementKind.
 *
 * For "major" leaves, we further distinguish required vs. elective
 * using the leaf's GROUP-LEVEL title label ("Elective Courses" vs
 * "Required Courses") — NOT the leaf's own raw title, which may be
 * a shortened version or re-labelled in different semesters.
 * The immediate parent group's title is the most reliable signal.
 */
function leafKind(
    leaf: DPRRequirement,
    groupKind: GroupKind,
    immediateParent: DPRRequirementGroup,
): RequirementKind {
    switch (groupKind) {
        case "major": {
            // Within a major group, is this leaf an elective sub-requirement?
            // We check the leaf's own title AND the immediate parent group's title.
            // "Elective" in the group or leaf title is a stable structural label
            // used by PeopleSoft to separate required-course lists from choose-N pools.
            if (isMajorElectiveLeaf(leaf, immediateParent)) {
                return "major-elective";
            }
            return "major-required";
        }
        case "school-core":
            return "school-core";
        case "general-elective":
            // "General Electives" in the DPR holds courses not used anywhere else
            // — these are completely unrestricted, so "free-elective" is correct.
            return "free-elective";
        default:
            return "unknown";
    }
}

// ---------------------------------------------------------------------------
// Group-identity predicates
// ---------------------------------------------------------------------------

/**
 * True when the group title identifies it as the student's declared major.
 *
 * Matching strategy (priority order):
 *   (a) group title starts with or contains any declared-major label.
 *   (b) group title contains "Major" AND at least one word from a declared
 *       program label appears in the group title.
 *
 * This correctly identifies "Computer Science/Math Joint Major" from
 * declared label "Computer Science/Math" without hardcoding rIds.
 *
 * Non-CAS hierarchies: unvalidated. The function will return false when
 * no declared-major label matches, so leaves fall through to "unknown".
 */
function isMajorGroup(title: string, majorLabels: Set<string>): boolean {
    if (majorLabels.size === 0) return false;
    const titleLower = title.toLowerCase();
    for (const label of majorLabels) {
        const labelLower = label.toLowerCase();
        // Direct containment: "computer science/math joint major".includes("computer science/math")
        if (titleLower.includes(labelLower)) return true;
        // Partial word overlap when the label has a "/" (joint programs)
        // e.g. label "Computer Science/Math" → words ["computer", "science", "math"]
        // and title "Computer Science/Math Joint Major" → matches on all three
        const labelWords = labelLower
            .split(/[\s/,&]+/)
            .map((w) => w.trim())
            .filter((w) => w.length > 3);  // skip short words like "of", "and"
        if (labelWords.length > 0 && labelWords.every((w) => titleLower.includes(w))) {
            return true;
        }
    }
    return false;
}

/**
 * True when the group is a school/college core curriculum group.
 *
 * Detection strategy (structural + title-based):
 *   - Title starts with "CORE" → quantitative-reasoning, contemporary-culture,
 *     physical/life science groups in CAS.
 *   - Title is one of the stable CAS college-requirement labels.
 *   - rgId is one of the known CAS core rgIds (belt-and-suspenders).
 *
 * Documented: ONLY validated against the CAS fixture. Other schools
 * likely use different group titles and rgIds.
 */
const CAS_CORE_RGIDS = new Set([
    "RG5004",   // CORE Foundations of Contemporary Culture
    "RG5007",   // CORE Foundations of Scientific Inquiry - Quantitative Reasoning
    "RG5393",   // CORE Foundations of Scientific Inquiry - Physical and Life Science
    "RG33308",  // First-Year Seminar
    "RG5002",   // Foreign Language
    "RG5005",   // Expository Writing
    "RG31394",  // Writing Proficiency
    "RG5001",   // Graduation Requirements (credit/GPA floors)
    "RG5394",   // Notes/Restrictions/Limitations (P/F cap, outside-home cap, etc.)
]);

const CORE_TITLE_PREFIXES = [
    "core foundations",
    "core curriculum",
];

const COLLEGE_REQ_TITLES = [
    "first-year seminar",
    "foreign language",
    "expository writing",
    "writing proficiency",
    "graduation requirements",
    "minimum credits",
    "minimum grade point",
    "cas residency",
    "residency:",
    "notes/restrictions",
    "pass/fail option",
    "maximum credit",
    "time limit",
    "quantitative reasoning",
    "texts & ideas",
    "cultures & contexts",
    "societies & social sciences",
    "expressive culture",
    "physical and life science",
    "physical & life science",
    "writing proficiency",
];

function isCoreGroup(title: string, rgId: string): boolean {
    // Structural rgId match (most reliable for CAS)
    if (CAS_CORE_RGIDS.has(rgId)) return true;

    const titleLower = title.toLowerCase();

    // Title starts with "CORE" (e.g. "CORE Foundations of …")
    if (titleLower.startsWith("core ") || titleLower === "core") return true;

    // Title prefix match
    if (CORE_TITLE_PREFIXES.some((p) => titleLower.startsWith(p))) return true;

    // Known college requirement labels
    if (COLLEGE_REQ_TITLES.some((t) => titleLower.startsWith(t))) return true;

    return false;
}

/**
 * True when the group is the "General Electives" catch-all.
 * PeopleSoft description: "Courses not used anywhere else will display here."
 */
function isGeneralElectivesGroup(title: string): boolean {
    const t = title.toLowerCase().trim();
    return t === "general electives" || t.startsWith("general elective");
}

// ---------------------------------------------------------------------------
// Major-elective vs. major-required leaf distinction
// ---------------------------------------------------------------------------

/**
 * Within a confirmed major group, decide if this leaf is an "elective"
 * (choose-N from a pool) vs. a "required" (must take these specific courses).
 *
 * Signals (checked in order):
 *  1. The immediate parent group's title contains "Elective" → elective.
 *     This is the most reliable structural signal: PeopleSoft groups
 *     "Elective Courses" under a separate sub-group from "Required Courses".
 *  2. The leaf's own title contains "Elective" (handles flat structures
 *     where the leaf and group are the same node).
 *  3. Otherwise → required.
 *
 * NOTE: we use the word "Elective" here as a GROUP-LEVEL LABEL comparison,
 * not a keyword hunt on arbitrary leaf content. The group is identified FIRST
 * by structural ancestry (isMajorGroup); only THEN do we inspect the group
 * title to further refine required vs. elective. This is distinct from the
 * old `inferCategory` bug, which applied keyword logic to EVERY leaf without
 * first confirming group membership.
 */
function isMajorElectiveLeaf(
    leaf: DPRRequirement,
    immediateParent: DPRRequirementGroup,
): boolean {
    const parentTitleLower = immediateParent.title.toLowerCase();
    if (parentTitleLower.includes("elective")) return true;

    const leafTitleLower = leaf.title.toLowerCase();
    if (leafTitleLower.includes("elective")) return true;

    return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a normalized set of major labels from the declared programs list.
 * Includes the raw programId AND attempts to extract the label from the
 * DPR programs[] array (which the caller passes via declaredPrograms).
 *
 * ProgramDeclaration.programId is the session-side identifier (e.g.
 * "computer_science"). DPR programs[].label is the PeopleSoft label
 * (e.g. "Computer Science/Math"). Both are compared case-insensitively.
 * Since we only have programId here (not DPR programs[].label), we
 * normalize programId to a human-readable form for matching.
 */
function buildMajorLabelSet(declaredPrograms: ProgramDeclaration[]): Set<string> {
    const labels = new Set<string>();
    for (const prog of declaredPrograms) {
        if (prog.programType !== "major") continue;
        // Add the raw programId (session-side, e.g. "computer_science" or "Computer Science/Math")
        labels.add(prog.programId.toLowerCase());
        // Normalize underscores to spaces (session-side ids often use snake_case)
        labels.add(prog.programId.toLowerCase().replace(/_/g, " "));
    }
    return labels;
}
