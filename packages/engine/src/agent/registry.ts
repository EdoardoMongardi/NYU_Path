// ============================================================
// Default ToolRegistry — wires the 9 NYU Path tools (§7.2 + Phase 6 WS7b)
// ============================================================
// Tools (9 of §7.1's 12; remainder scheduled for Phase 7):
//   run_full_audit, plan_semester, check_transfer_eligibility,
//   what_if_audit, search_policy, update_profile, confirm_profile_update,
//   get_credit_caps, search_availability
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
};
