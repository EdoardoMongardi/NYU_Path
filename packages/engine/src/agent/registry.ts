// ============================================================
// Default ToolRegistry — wires the 19 NYU Path tools (§7.1 + Phase 13 + Phase 14)
// ============================================================
// All §7.1 tools shipped:
//   run_full_audit, plan_semester, check_transfer_eligibility,
//   what_if_audit, search_policy, update_profile, confirm_profile_update,
//   get_credit_caps, search_availability, get_academic_standing,
//   check_overlap, search_courses
// Phase 13 Task 6 additions:
//   plan_forward_degree, view_forward_plan
// Phase 14 Task 5 additions:
//   propose_plan_change, confirm_plan_change, simulate_alternatives
// Phase 14 Task 6 additions:
//   bind_free_elective, bind_pool_slot
// ============================================================
import { ToolRegistry, type Tool } from "./tool.js";
import { runFullAuditTool } from "./tools/runFullAudit.js";
import { planSemesterTool } from "./tools/planSemester.js";
import { checkTransferEligibilityTool } from "./tools/checkTransferEligibility.js";
import { whatIfAuditTool } from "./tools/whatIfAudit.js";
import { searchPolicyTool } from "./tools/searchPolicy.js";
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
import type { ZodTypeAny } from "zod";

export const ALL_NYUPATH_TOOLS: Array<Tool<ZodTypeAny, unknown>> = [
    runFullAuditTool as unknown as Tool<ZodTypeAny, unknown>,
    planSemesterTool as unknown as Tool<ZodTypeAny, unknown>,
    checkTransferEligibilityTool as unknown as Tool<ZodTypeAny, unknown>,
    whatIfAuditTool as unknown as Tool<ZodTypeAny, unknown>,
    searchPolicyTool as unknown as Tool<ZodTypeAny, unknown>,
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
};
