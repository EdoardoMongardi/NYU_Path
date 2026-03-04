// Engine barrel export
export { degreeAudit } from "./audit/degreeAudit.js";
export { evaluateRule } from "./audit/ruleEvaluator.js";
export { PrereqGraph } from "./graph/prereqGraph.js";
export { EquivalenceResolver } from "./equivalence/equivalenceResolver.js";
export { loadCourses, loadPrereqs, loadPrograms, loadProgram } from "./dataLoader.js";

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
