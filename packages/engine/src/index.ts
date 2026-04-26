// Engine barrel export
export { degreeAudit } from "./audit/degreeAudit.js";
export { evaluateRule } from "./audit/ruleEvaluator.js";
export { validateCreditCaps } from "./audit/creditCapValidator.js";
export { checkPassFailViolations } from "./audit/passfailGuard.js";
export { calculateStanding, computeSemesterGPA } from "./audit/academicStanding.js";
export { PrereqGraph } from "./graph/prereqGraph.js";
export { EquivalenceResolver } from "./equivalence/equivalenceResolver.js";
export { loadCourses, loadPrereqs, loadPrograms, loadProgram } from "./dataLoader.js";
export { resolveExamCredit, EXAM_GENERAL_RULES } from "./data/examEquivalencies.js";

// Phase 1: Planner
export { planNextSemester } from "./planner/semesterPlanner.js";
export { scoreCourses } from "./planner/priorityScorer.js";
export { detectGraduationRisks } from "./planner/graduationRisk.js";

// Phase 1: NYU API Client
export {
    searchCourses,
    getCourseDetails,
    fetchTermCourses,
    extractAvailableCourseIds,
    extractAllCourseIds,
    generateTermCode,
    getRecentTermOptions,
} from "./api/nyuClassSearch.js";

// Phase 0: Provenance schema
export {
    metaSchema,
    validateMeta,
    isStale,
    STALENESS_DAYS,
    type Meta,
} from "./provenance/schema.js";

// Phase 0: Catalog-year pinning loader
export {
    resolveProgramFile,
    applicableCatalogYear,
    type ResolveResult,
} from "./data/catalogYearLoader.js";

// Phase 0: Departments stub (reserved precedence slot)
export {
    loadDepartmentConfig,
    type DepartmentConfig,
} from "./data/departmentLoader.js";

// Phase 0: Tool registry + first tool
export {
    buildTool,
    getTool,
    listTools,
    registerTool,
    searchAvailability,
    type SearchAvailabilityInput,
    type SearchAvailabilityOutput,
    type SectionView,
    type Tool,
    type ToolContext,
    type ToolDef,
    type ValidationResult,
} from "./tools/index.js";
