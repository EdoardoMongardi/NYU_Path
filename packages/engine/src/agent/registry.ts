// ============================================================
// Default ToolRegistry — wires the 22 LIVE NYU Path tools
// ============================================================
// §7.1 tools (Phase 0–11):
//   run_full_audit, what_if_audit,
//   search_policy, update_profile, confirm_profile_update,
//   get_credit_caps, search_availability, get_academic_standing,
//   search_courses
// REMOVED (improvement plan — pure-RAG decommission):
//   check_overlap — the authored cross-program double-count audit
//   (crossProgramAudit over programs.json) is gone. Double-counting
//   POLICY ("no more than two courses…") comes from `search_policy`;
//   the student's per-program requirement satisfaction comes from
//   `run_full_audit` (the DPR). The rule engine + programs.json that
//   backed it are removed in the following step.
//   check_transfer_eligibility — the authored CAS→Stern transfer route
//   (data/transfers/*.json) is gone; internal-transfer questions are now
//   answered by `search_policy` over the bulletin's internal-transfer
//   pages (which cover every school, not just the one hardcoded route).
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
// Phase 3 (advisor) D2.1 addition:
//   probe_counterfactual — read-only what-if (Arm A future_course mutations /
//   Arm B fail_completed synthetic-DPR transform). Re-solves + 8-axis-validates
//   without writing session; the diff (valid) or binding constraint (infeasible).
//
// REMOVED (improvement plan, Phase F decommission):
//   plan_semester — the Phase 5 single-term planner + its `planFeasibility`
//   verifier were deleted. They were superseded by Phase 13's
//   `plan_forward_degree` (plans every remaining term, writes
//   `session.forwardSchedule`, cooperates with `propose_plan_change`) and
//   had been unregistered since May 2026. Per the strangler-fig
//   decommission, the dead twin is now gone so there is one way to plan.
// ============================================================
import { ToolRegistry, type Tool } from "./tool.js";
import { runFullAuditTool } from "./tools/runFullAudit.js";
import { whatIfAuditTool } from "./tools/whatIfAudit.js";
import { searchPolicyTool } from "./tools/searchPolicy.js";
import { getProgramRequirementsTool } from "./tools/getProgramRequirements.js";
import { updateProfileTool, confirmProfileUpdateTool } from "./tools/updateProfile.js";
import { getCreditCapsTool } from "./tools/getCreditCaps.js";
import { searchAvailabilityTool } from "./tools/searchAvailability.js";
import { getAcademicStandingTool } from "./tools/getAcademicStanding.js";
import { searchCoursesTool } from "./tools/searchCourses.js";
import { planForwardDegreeTool } from "./tools/planForwardDegree.js";
import { viewForwardPlanTool } from "./tools/viewForwardPlan.js";
import { proposePlanChangeTool } from "./tools/proposePlanChange.js";
import { probeCounterfactualTool } from "./tools/probeCounterfactual.js";
import { proposeWhatIfAssumptionTool } from "./tools/proposeWhatIfAssumption.js";
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
    whatIfAuditTool as unknown as Tool<ZodTypeAny, unknown>,
    searchPolicyTool as unknown as Tool<ZodTypeAny, unknown>,
    getProgramRequirementsTool as unknown as Tool<ZodTypeAny, unknown>,
    updateProfileTool as unknown as Tool<ZodTypeAny, unknown>,
    confirmProfileUpdateTool as unknown as Tool<ZodTypeAny, unknown>,
    getCreditCapsTool as unknown as Tool<ZodTypeAny, unknown>,
    searchAvailabilityTool as unknown as Tool<ZodTypeAny, unknown>,
    getAcademicStandingTool as unknown as Tool<ZodTypeAny, unknown>,
    searchCoursesTool as unknown as Tool<ZodTypeAny, unknown>,
    planForwardDegreeTool as unknown as Tool<ZodTypeAny, unknown>,
    viewForwardPlanTool as unknown as Tool<ZodTypeAny, unknown>,
    proposePlanChangeTool as unknown as Tool<ZodTypeAny, unknown>,
    probeCounterfactualTool as unknown as Tool<ZodTypeAny, unknown>,
    proposeWhatIfAssumptionTool as unknown as Tool<ZodTypeAny, unknown>,
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
    whatIfAuditTool,
    searchPolicyTool,
    getProgramRequirementsTool,
    updateProfileTool,
    confirmProfileUpdateTool,
    getCreditCapsTool,
    searchAvailabilityTool,
    getAcademicStandingTool,
    searchCoursesTool,
    planForwardDegreeTool,
    viewForwardPlanTool,
    proposePlanChangeTool,
    probeCounterfactualTool,
    proposeWhatIfAssumptionTool,
    confirmPlanChangeTool,
    simulateAlternativesTool,
    bindFreeElectiveTool,
    bindPoolSlotTool,
    comparePlanAlternativesTool,
    materializeSectionsTool,
    confirmSectionCombinationTool,
};
