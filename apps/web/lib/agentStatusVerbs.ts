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

/**
 * Natural-language thought sentences appended to the streaming
 * "Reasoning" trace as each tool fires. Written in first-person
 * to read like the model thinking out loud — these are NOT the
 * model's actual chain-of-thought (which would require enabling
 * extended thinking and paying for thinking tokens). They are
 * synthesized from the deterministic tool sequence so the user
 * gets a human-readable narration of what the agent is doing.
 */
export const TOOL_THOUGHT_SENTENCES: Record<string, string> = {
    run_full_audit:             "Let me pull up your degree audit so I'm working from your actual progress, not assumptions.",
    plan_semester:              "Now I'll sketch a semester plan based on what's still unmet and how the workload should balance.",
    check_transfer_eligibility: "I should check the transfer eligibility rules first — there are credit and GPA thresholds to verify.",
    what_if_audit:              "Let me run a what-if audit to see how that hypothetical change would affect your remaining requirements.",
    search_policy:              "Let me look up the relevant NYU policy and bulletin pages so my answer is grounded in source material.",
    update_profile:             "I'll prepare a profile update — but I won't apply it until you confirm.",
    confirm_profile_update:     "Applying the staged profile update now.",
    get_credit_caps:            "Let me check the credit caps for your school and visa status so I don't suggest something over the ceiling.",
    search_availability:        "I should verify when those courses are actually offered before recommending them for a specific term.",
    get_academic_standing:      "Let me check your current academic standing — cumulative GPA and per-semester history.",
    check_overlap:              "I need to check whether any of these courses count toward more than one of your declared programs.",
    search_courses:             "Searching the course catalog for matches so I can pull real course IDs and titles.",
};

const TEMPLATE_THOUGHT = "This looks like a question I have a verified canned answer for. Let me grab that.";
const FALLBACK_THOUGHT = "Let me look into that.";

export function getThoughtSentence(toolName: string): string {
    if (toolName.startsWith("template:")) return TEMPLATE_THOUGHT;
    return TOOL_THOUGHT_SENTENCES[toolName] ?? FALLBACK_THOUGHT;
}
