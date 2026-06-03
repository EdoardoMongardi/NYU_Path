// ============================================================
// Default ToolRegistry — wires the 22 LIVE NYU Path tools
// ============================================================
// §7.1 tools (Phase 0–11):
//   run_full_audit, check_transfer_eligibility, what_if_audit,
//   search_policy, update_profile, confirm_profile_update,
//   get_credit_caps, search_availability, get_academic_standing,
//   check_overlap, search_courses
// Improvement-plan Phase B addition:
//   get_program_requirements — whole-PAGE bulletin retrieval for a
//   program/major/minor (every requirement section reassembled in
//   order), complementing search_policy's fragment retrieval.
// Phase 13 Task 6 additions:
//   plan_forward_degree, view_forward_plan
// Phase 14 Task 5 additions:
//   propose_plan_change, confirm_plan_change, simulate_alternatives
// Phase 14 Task 6 additions:
//   bind_free_elective, bind_pool_slot
// Phase 14 Task 7 additions:
//   compare_plan_alternatives
// Phase 15 Task 7 additions:
//   materialize_sections, confirm_section_combination
//
// DEPRECATED (May 2026 post-mortem):
//   plan_semester — Phase 5 single-term planner. Superseded by Phase 13's
//   `plan_forward_degree`, which (a) plans every remaining term, not just
//   the immediate one, (b) writes `session.forwardSchedule` so the UI can
//   display the schedule sidebar, and (c) cooperates with Phase 14's
//   `propose_plan_change` for what-if analysis. Keeping `plan_semester`
//   registered alongside the new tool caused the LLM to fall back to it
//   for "what should I take next semester" questions, leaving the forward
//   schedule unset and the sidebar empty. The tool's source file is kept
//   for unit tests + future reference, but it is no longer wired into
//   `ALL_NYUPATH_TOOLS` so the agent loop cannot invoke it.
// ============================================================
import { ToolRegistry, type Tool } from "./tool.js";
import { runFullAuditTool } from "./tools/runFullAudit.js";
// Deprecated — kept as a named export for back-compat with unit tests and
// future migration tooling, but NOT included in ALL_NYUPATH_TOOLS.
// See header comment for rationale.
import { planSemesterTool } from "./tools/planSemester.js";
import { checkTransferEligibilityTool } from "./tools/checkTransferEligibility.js";
import { whatIfAuditTool } from "./tools/whatIfAudit.js";
import { searchPolicyTool } from "./tools/searchPolicy.js";
import { getProgramRequirementsTool } from "./tools/getProgramRequirements.js";
import { updateProfileTool, confirmProfileUpdateTool } from "./tools/updateProfile.js";
import { getCreditCapsTool } from "./tools/getCreditCaps.js";
import { searchAvailabilityTool } from "./tools/searchAvailability.js";
import { getAcademicStandingTool } from "./tools/getAcademicStanding.js";
import { checkOverlapTool } from "./tools/checkOverlap.js";
import { searchCoursesTool } from "./tools/searchCourses.js";
import { planForwardDegreeTool } from "./tools/planForwardDegree.js";
import { viewForwardPlanTool } from "./tools/viewForwardPlan.js";
import { proposePlanChangeTool } from "./tools/proposePlanChange.js";
import { confirmPlanChangeTool } from "./tools/confirmPlanChange.js";
import { simulateAlternativesTool } from "./tools/simulateAlternatives.js";
import { bindFreeElectiveTool } from "./tools/bindFreeElective.js";
import { bindPoolSlotTool } from "./tools/bindPoolSlot.js";
import { comparePlanAlternativesTool } from "./tools/comparePlanAlternatives.js";
import {
    materializeSectionsTool,
    confirmSectionCombinationTool,
} from "./tools/materializeSections.js";
import type { ZodTypeAny } from "zod";

export const ALL_NYUPATH_TOOLS: Array<Tool<ZodTypeAny, unknown>> = [
    runFullAuditTool as unknown as Tool<ZodTypeAny, unknown>,
    // planSemesterTool intentionally NOT registered — see header.
    checkTransferEligibilityTool as unknown as Tool<ZodTypeAny, unknown>,
    whatIfAuditTool as unknown as Tool<ZodTypeAny, unknown>,
    searchPolicyTool as unknown as Tool<ZodTypeAny, unknown>,
    getProgramRequirementsTool as unknown as Tool<ZodTypeAny, unknown>,
    updateProfileTool as unknown as Tool<ZodTypeAny, unknown>,
    confirmProfileUpdateTool as unknown as Tool<ZodTypeAny, unknown>,
    getCreditCapsTool as unknown as Tool<ZodTypeAny, unknown>,
    searchAvailabilityTool as unknown as Tool<ZodTypeAny, unknown>,
    getAcademicStandingTool as unknown as Tool<ZodTypeAny, unknown>,
    checkOverlapTool as unknown as Tool<ZodTypeAny, unknown>,
    searchCoursesTool as unknown as Tool<ZodTypeAny, unknown>,
    planForwardDegreeTool as unknown as Tool<ZodTypeAny, unknown>,
    viewForwardPlanTool as unknown as Tool<ZodTypeAny, unknown>,
    proposePlanChangeTool as unknown as Tool<ZodTypeAny, unknown>,
    confirmPlanChangeTool as unknown as Tool<ZodTypeAny, unknown>,
    simulateAlternativesTool as unknown as Tool<ZodTypeAny, unknown>,
    bindFreeElectiveTool as unknown as Tool<ZodTypeAny, unknown>,
    bindPoolSlotTool as unknown as Tool<ZodTypeAny, unknown>,
    comparePlanAlternativesTool as unknown as Tool<ZodTypeAny, unknown>,
    materializeSectionsTool as unknown as Tool<ZodTypeAny, unknown>,
    confirmSectionCombinationTool as unknown as Tool<ZodTypeAny, unknown>,
];

/**
 * Build a fresh `ToolRegistry` containing the default NYU Path tools.
 * The agent orchestrator constructs one of these per session.
 */
export function buildDefaultRegistry(): ToolRegistry {
    return new ToolRegistry([...ALL_NYUPATH_TOOLS]);
}

export {
    runFullAuditTool,
    planSemesterTool,
    checkTransferEligibilityTool,
    whatIfAuditTool,
    searchPolicyTool,
    getProgramRequirementsTool,
    updateProfileTool,
    confirmProfileUpdateTool,
    getCreditCapsTool,
    searchAvailabilityTool,
    getAcademicStandingTool,
    checkOverlapTool,
    searchCoursesTool,
    planForwardDegreeTool,
    viewForwardPlanTool,
    proposePlanChangeTool,
    confirmPlanChangeTool,
    simulateAlternativesTool,
    bindFreeElectiveTool,
    bindPoolSlotTool,
    comparePlanAlternativesTool,
    materializeSectionsTool,
    confirmSectionCombinationTool,
};
