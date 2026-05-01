/**
 * User-facing verbs for the 12 tools in the engine registry.
 * The active form is shown while the tool is running (the chat UI
 * appends "…" at render time). The past form is shown in the
 * post-completion expandable trace.
 *
 * If a tool name is not in this map (e.g. a newly-added tool the
 * UI has not been updated for, or a `template:*` pseudo-tool that
 * surfaces template-match events), getActiveVerb / getPastVerb
 * fall back to a generic verb so the UI never crashes.
 */
export type ToolVerb = { active: string; past: string };

export const TOOL_VERBS: Record<string, ToolVerb> = {
    run_full_audit:             { active: "Running your degree audit",        past: "Ran your degree audit" },
    plan_semester:              { active: "Planning your semester",           past: "Planned a semester" },
    check_transfer_eligibility: { active: "Checking transfer eligibility",    past: "Checked transfer eligibility" },
    what_if_audit:              { active: "Running a what-if audit",          past: "Ran a what-if audit" },
    search_policy:              { active: "Looking up policy",                past: "Looked up policy" },
    update_profile:             { active: "Preparing a profile update",       past: "Prepared a profile update" },
    confirm_profile_update:     { active: "Updating your profile",            past: "Updated your profile" },
    get_credit_caps:            { active: "Checking credit caps",             past: "Checked credit caps" },
    search_availability:        { active: "Checking course offerings",        past: "Checked course offerings" },
    get_academic_standing:      { active: "Reading your academic standing",   past: "Read your academic standing" },
    check_overlap:              { active: "Checking course overlap",          past: "Checked course overlap" },
    search_courses:             { active: "Searching the course catalog",     past: "Searched the course catalog" },
};

const TEMPLATE_VERB: ToolVerb = { active: "Checking a known answer", past: "Matched a known answer" };
const FALLBACK_VERB: ToolVerb = { active: "Working", past: "Used a tool" };

export const IDLE_VERB = "Thinking";

export function getActiveVerb(toolName: string): string {
    if (toolName.startsWith("template:")) return TEMPLATE_VERB.active;
    return TOOL_VERBS[toolName]?.active ?? FALLBACK_VERB.active;
}

export function getPastVerb(toolName: string): string {
    if (toolName.startsWith("template:")) return TEMPLATE_VERB.past;
    return TOOL_VERBS[toolName]?.past ?? FALLBACK_VERB.past;
}
