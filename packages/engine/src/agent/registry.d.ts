import { ToolRegistry, type Tool } from "./tool.js";
import { runFullAuditTool } from "./tools/runFullAudit.js";
import { planSemesterTool } from "./tools/planSemester.js";
import { checkTransferEligibilityTool } from "./tools/checkTransferEligibility.js";
import { whatIfAuditTool } from "./tools/whatIfAudit.js";
import { searchPolicyTool } from "./tools/searchPolicy.js";
import { updateProfileTool, confirmProfileUpdateTool } from "./tools/updateProfile.js";
import type { ZodTypeAny } from "zod";
export declare const ALL_NYUPATH_TOOLS: Array<Tool<ZodTypeAny, unknown>>;
/**
 * Build a fresh `ToolRegistry` containing the default NYU Path tools.
 * The agent orchestrator constructs one of these per session.
 */
export declare function buildDefaultRegistry(): ToolRegistry;
export { runFullAuditTool, planSemesterTool, checkTransferEligibilityTool, whatIfAuditTool, searchPolicyTool, updateProfileTool, confirmProfileUpdateTool, };
//# sourceMappingURL=registry.d.ts.map