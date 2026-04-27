// ============================================================
// Default ToolRegistry — wires the 12 NYU Path tools (§7.1 complete)
// ============================================================
// All §7.1 tools shipped:
//   run_full_audit, plan_semester, check_transfer_eligibility,
//   what_if_audit, search_policy, update_profile, confirm_profile_update,
//   get_credit_caps, search_availability, get_academic_standing,
//   check_overlap, search_courses
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
};
