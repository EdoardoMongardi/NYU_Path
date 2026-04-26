// ============================================================
// Default ToolRegistry — wires the 7 NYU Path tools (Phase 5 §7.2)
// ============================================================
// Tools (7 of §7.1's 12; remainder scheduled for Phase 6):
//   run_full_audit, plan_semester, check_transfer_eligibility,
//   what_if_audit, search_policy, update_profile, confirm_profile_update
// ============================================================
import { ToolRegistry } from "./tool.js";
import { runFullAuditTool } from "./tools/runFullAudit.js";
import { planSemesterTool } from "./tools/planSemester.js";
import { checkTransferEligibilityTool } from "./tools/checkTransferEligibility.js";
import { whatIfAuditTool } from "./tools/whatIfAudit.js";
import { searchPolicyTool } from "./tools/searchPolicy.js";
import { updateProfileTool, confirmProfileUpdateTool } from "./tools/updateProfile.js";
export const ALL_NYUPATH_TOOLS = [
    runFullAuditTool,
    planSemesterTool,
    checkTransferEligibilityTool,
    whatIfAuditTool,
    searchPolicyTool,
    updateProfileTool,
    confirmProfileUpdateTool,
];
/**
 * Build a fresh `ToolRegistry` containing the default NYU Path tools.
 * The agent orchestrator constructs one of these per session.
 */
export function buildDefaultRegistry() {
    return new ToolRegistry([...ALL_NYUPATH_TOOLS]);
}
export { runFullAuditTool, planSemesterTool, checkTransferEligibilityTool, whatIfAuditTool, searchPolicyTool, updateProfileTool, confirmProfileUpdateTool, };
//# sourceMappingURL=registry.js.map