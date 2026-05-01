// ============================================================
// DPR module barrel exports (Phase 7-E W1.7)
// ============================================================
export {
    degreeProgressReportSchema,
    dprMetaSchema,
    dprHeaderSchema,
    dprProgramSchema,
    dprAdvisorNotationSchema,
    dprCumulativeSchema,
    dprRequirementGroupSchema,
    dprRequirementSchema,
    dprCounterSchema,
    dprCourseRowSchema,
    dprStatusSchema,
    walkRequirements,
    notSatisfiedRequirements,
    findRequirementById,
} from "./schema.js";
export type {
    DegreeProgressReport,
    DPRMeta,
    DPRHeader,
    DPRProgram,
    DPRAdvisorNotation,
    DPRCumulative,
    DPRRequirementGroup,
    DPRRequirement,
    DPRCounter,
    DPRCourseRow,
    DPRStatus,
} from "./schema.js";

// Parser
export { parseDpr } from "./parser.js";
export type {
    ParseDprOptions,
    ParseDprResult,
    ParseDprSuccess,
    ParseDprFailure,
} from "./parser.js";

// Adapter to legacy AuditResult shape
export {
    dprToAuditResults,
    dprToPrimaryAuditResult,
} from "./dprToAuditResult.js";
export type { DprToAuditOptions } from "./dprToAuditResult.js";

// Temporal-context derivation
export {
    deriveTemporalContext,
    normalizeGraduationTarget,
} from "./temporalContext.js";
export type { DprTemporalContext } from "./temporalContext.js";
