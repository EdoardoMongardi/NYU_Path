#!/usr/bin/env npx tsx
// ============================================================
// Advisory Quality Evaluation — Layer C (§5.4)
// Generates chatbot responses, runs GPT-4 judge for claim
// extraction + grounding classification, outputs calibration CSV.
// ============================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Load .env ----
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "../../../../apps/web/.env");
if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = value;
    }
    console.log("📁 Loaded environment from apps/web/.env");
}

import type { StudentProfile, Program, Course, PlannerConfig, SemesterPlan } from "@nyupath/shared";
import type { Prerequisite } from "@nyupath/shared";
import { degreeAudit } from "../../src/audit/degreeAudit.js";
import { planNextSemester } from "../../src/planner/semesterPlanner.js";
import { handleMessage, type ChatContext, type AuditData, type PlanData } from "../../src/chat/chatOrchestrator.js";
import { createOpenAIClient, type LLMClient } from "../../src/chat/llmClient.js";
import { ACADEMIC_RULES } from "../../src/data/academicRules.js";
import { JUDGE_SYSTEM_PROMPT, buildJudgePrompt, type JudgeResult, type JudgeClaim } from "./judgePrompt.js";

const DATA_DIR = join(__dirname, "../../src/data");
const PROFILES_DIR = join(__dirname, "profiles");

// ---- Load shared data ----
const courses: Course[] = JSON.parse(readFileSync(join(DATA_DIR, "courses.json"), "utf-8"));
const programs: Program[] = JSON.parse(readFileSync(join(DATA_DIR, "programs.json"), "utf-8"));
const prereqs: Prerequisite[] = JSON.parse(readFileSync(join(DATA_DIR, "prereqs.json"), "utf-8"));

function loadProfile(name: string): StudentProfile {
    return JSON.parse(readFileSync(join(PROFILES_DIR, `${name}.json`), "utf-8"));
}

function getProgram(id: string): Program {
    const p = programs.find(p => p.programId === id);
    if (!p) throw new Error(`Program ${id} not found`);
    return p;
}

// ---- Scenario Definitions ----
interface EvalScenario {
    id: string;
    query: string;
    profileName: string;
    expectedIntent: string;
    /** Function to build ground truth string from engine output */
    getGroundTruth: (student: StudentProfile, program: Program) => string;
}

const csProgram = getProgram("cs_major_ba");

/** Build a student profile summary for the judge to check course history */
function buildStudentContext(student: StudentProfile): string {
    return `STUDENT PROFILE:
- ID: ${student.id}
- Catalog Year: ${student.catalogYear}
- Visa Status: ${(student as any).visaStatus ?? "domestic"}
- Courses Already Completed: ${student.coursesTaken.map(c => `${c.courseId} (${c.grade})`).join(", ") || "none"}
- Total Courses Taken: ${student.coursesTaken.length}`;
}

function buildAuditGroundTruth(student: StudentProfile, program: Program): string {
    const audit = degreeAudit(student, program, courses);
    return `${buildStudentContext(student)}

DEGREE AUDIT RESULTS:
- Program: ${program.programName}
- Total Credits Completed: ${audit.totalCreditsCompleted}
- Total Credits Required: ${program.totalCreditsRequired}
- Credits Remaining: ${program.totalCreditsRequired - audit.totalCreditsCompleted}
- Rules Completed: ${audit.rules.filter(r => r.status === "satisfied").length} / ${audit.rules.length}
- Unmet Rules: ${audit.rules.filter(r => r.status !== "satisfied").map(r => `${r.ruleId}: ${r.remaining} remaining (${r.coursesRemaining.join(", ")})`).join("; ")}
- Warnings: ${audit.warnings.join("; ") || "none"}

ACADEMIC RULES (abridged):
${ACADEMIC_RULES.slice(0, 2000)}`;
}

function buildPlanGroundTruth(student: StudentProfile, program: Program): string {
    const config: PlannerConfig = {
        targetSemester: "2025-fall",
        maxCourses: 5,
        maxCredits: 18,
        targetGraduation: "2027-spring",
    };
    const plan = planNextSemester(student, program, courses, prereqs, config);
    return `${buildStudentContext(student)}

SEMESTER PLAN:
- Target: ${plan.targetSemester}
- Suggestions: ${plan.suggestions.map(s => `${s.courseId} (${s.title}, ${s.credits}cr, ${s.category})`).join("; ")}
- Planned Credits: ${plan.plannedCredits}
- Risks: ${plan.risks.map(r => `[${r.level}] ${r.message}`).join("; ") || "none"}
- Enrollment Warnings: ${plan.enrollmentWarnings.join("; ") || "none"}
- Free Slots: ${plan.freeSlots}

ACADEMIC RULES (abridged):
${ACADEMIC_RULES.slice(0, 2000)}`;
}

function buildRulesGroundTruth(student: StudentProfile, _program: Program): string {
    return `${buildStudentContext(student)}

ACADEMIC RULES:
${ACADEMIC_RULES}`;
}

const SCENARIOS: EvalScenario[] = [
    // ── Original 15 calibration scenarios ──────────────────────────
    {
        id: "AQ-01",
        query: "How many credits do I still need to graduate?",
        profileName: "freshman_clean",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-02",
        query: "What should I take next fall semester?",
        profileName: "freshman_clean",
        expectedIntent: "plan_explain",
        getGroundTruth: buildPlanGroundTruth,
    },
    {
        id: "AQ-03",
        query: "Which CS electives should I consider?",
        profileName: "sophomore_mixed_grades",
        expectedIntent: "elective_search",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-04",
        query: "Am I on track to graduate on time?",
        profileName: "freshman_clean",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-05",
        query: "Can I use MATH-UA 122 as a CS elective?",
        profileName: "freshman_clean",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-06",
        query: "What are the prerequisites for Algorithms (CSCI-UA 310)?",
        profileName: "freshman_clean",
        expectedIntent: "general",
        getGroundTruth: (student, program) => {
            const prereqData = prereqs.find(p => p.course === "CSCI-UA 310");
            return `PREREQUISITE DATA for CSCI-UA 310:\n${JSON.stringify(prereqData, null, 2)}\n\n${buildRulesGroundTruth(student, program)}`;
        },
    },
    {
        id: "AQ-07",
        query: "Do I still need to take a writing course?",
        profileName: "freshman_clean",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-08",
        query: "What happens if I fail CSCI-UA 201?",
        profileName: "sophomore_mixed_grades",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-09",
        query: "How many CS courses do I have left?",
        profileName: "sophomore_mixed_grades",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-10",
        query: "Is taking 18 credits in one semester too much?",
        profileName: "freshman_clean",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-11",
        query: "What Core requirements do I still need to complete?",
        profileName: "freshman_clean",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-12",
        query: "Should I take Operating Systems or Algorithms first?",
        profileName: "freshman_clean",
        expectedIntent: "plan_explain",
        getGroundTruth: buildPlanGroundTruth,
    },
    {
        id: "AQ-13",
        query: "Can I take a class pass/fail for my major?",
        profileName: "freshman_clean",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-14",
        query: "I'm an F-1 student. What's the minimum credit load?",
        profileName: "fl_exempt",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-15",
        query: "Plan my next semester — I'm interested in machine learning",
        profileName: "sophomore_mixed_grades",
        expectedIntent: "plan_explain",
        getGroundTruth: buildPlanGroundTruth,
    },

    // ── At-Scale: low_gpa profile ───────────────────────────────────
    {
        id: "AQ-16",
        query: "Am I at risk of academic dismissal?",
        profileName: "low_gpa",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-17",
        query: "What happens if my GPA stays below 2.0?",
        profileName: "low_gpa",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-18",
        query: "I got an F in Data Structures. What do I do?",
        profileName: "low_gpa",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },

    // ── At-Scale: transfer_heavy profile ──────────────────────────────
    {
        id: "AQ-19",
        query: "How many transfer credits do I have?",
        profileName: "transfer_heavy",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-20",
        query: "Can my transfer credits count toward my CS major?",
        profileName: "transfer_heavy",
        expectedIntent: "general",
        getGroundTruth: buildAuditGroundTruth,
    },

    // ── At-Scale: passfail_violation profile ─────────────────────────
    {
        id: "AQ-21",
        query: "What are the pass/fail rules for foreign language courses?",
        profileName: "passfail_violation",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-22",
        query: "How many pass/fail courses can I take per semester?",
        profileName: "passfail_violation",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },

    // ── At-Scale: math_sub_overflow profile ──────────────────────────
    {
        id: "AQ-23",
        query: "I already used 2 math courses for CS electives. Can I use a third?",
        profileName: "math_sub_overflow",
        expectedIntent: "general",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-24",
        query: "How many math substitutions am I allowed?",
        profileName: "math_sub_overflow",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },

    // ── At-Scale: credit_cap_stress profile ──────────────────────────
    {
        id: "AQ-25",
        query: "I have a lot of transfer and online credits. Are there any limits?",
        profileName: "credit_cap_stress",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-26",
        query: "What is the maximum number of online credits that count toward my degree?",
        profileName: "credit_cap_stress",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },

    // ── At-Scale: freshman_ap profile ────────────────────────────────
    {
        id: "AQ-27",
        query: "My AP Computer Science A score counted. Which course did it replace?",
        profileName: "freshman_ap",
        expectedIntent: "general",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-28",
        query: "Do my AP credits count toward the 128-credit requirement?",
        profileName: "freshman_ap",
        expectedIntent: "general",
        getGroundTruth: buildAuditGroundTruth,
    },

    // ── At-Scale: senior_almost_done profile ─────────────────────────
    {
        id: "AQ-29",
        query: "Am I eligible to graduate this semester?",
        profileName: "senior_almost_done",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-30",
        query: "What do I still need to complete before graduation?",
        profileName: "senior_almost_done",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-31",
        query: "Can I take more than 5 CS electives?",
        profileName: "senior_almost_done",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },

    // ── At-Scale: fl_exempt (F-1 visa) profile ───────────────────────
    {
        id: "AQ-32",
        query: "Can I drop to part-time as an F-1 student?",
        profileName: "fl_exempt",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-33",
        query: "How many online courses can I take as an international student?",
        profileName: "fl_exempt",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },

    // ── At-Scale: sophomore_mixed_grades (diverse queries) ───────────
    {
        id: "AQ-34",
        query: "My grade in CORE-UA 701 was C-. Does it count toward Core?",
        profileName: "sophomore_mixed_grades",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-35",
        query: "I got a D+ in CSCI-UA 202.  Does it count toward my major?",
        profileName: "sophomore_mixed_grades",
        expectedIntent: "audit_status",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-36",
        query: "What is a good 4-year graduation plan for me?",
        profileName: "freshman_clean",
        expectedIntent: "plan_explain",
        getGroundTruth: buildPlanGroundTruth,
    },
    {
        id: "AQ-37",
        query: "Can I double-count a course for both Core and my CS major?",
        profileName: "sophomore_mixed_grades",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },

    // ── At-Scale: stress / edge cases ────────────────────────────────
    {
        id: "AQ-38",
        query: "I need to withdraw from a course. What happens to my credits?",
        profileName: "freshman_clean",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-39",
        query: "Can I repeat a course I already passed to get a better grade?",
        profileName: "sophomore_mixed_grades",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-40",
        query: "What's the minimum GPA I need to stay in the CS major?",
        profileName: "low_gpa",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
    {
        id: "AQ-41",
        query: "What elective options do I have if I've already taken MATH-UA 122 and 140?",
        profileName: "math_sub_overflow",
        expectedIntent: "general",
        getGroundTruth: buildAuditGroundTruth,
    },
    {
        id: "AQ-42",
        query: "Can I take 19 credits in a semester?",
        profileName: "freshman_clean",
        expectedIntent: "general",
        getGroundTruth: buildRulesGroundTruth,
    },
];


// ---- Build ChatContext for a profile ----
function buildContext(student: StudentProfile, program: Program): ChatContext {
    const audit = degreeAudit(student, program, courses);

    return {
        studentName: student.id,
        studentContext: [
            `Completed courses: ${student.coursesTaken.map(c => `${c.courseId} (${c.grade})`).join(", ") || "none"}`,
            `Credits earned: ${audit.totalCreditsCompleted}/128`,
            `Visa: ${(student as any).visaStatus ?? "domestic"}`,
            `Catalog year: ${student.catalogYear}`,
        ].join("\n"),
        runAudit: async (): Promise<AuditData> => ({
            programName: program.programName,
            totalCreditsCompleted: audit.totalCreditsCompleted,
            totalCreditsRequired: program.totalCreditsRequired,
            rulesCompleted: audit.rules.filter(r => r.status === "satisfied").length,
            rulesTotal: audit.rules.length,
            unmetRules: audit.rules
                .filter(r => r.status !== "satisfied")
                .map(r => `${r.ruleId}: ${r.remaining} courses remaining (${r.coursesRemaining.join(", ")})`),
        }),
        runPlan: async (): Promise<PlanData> => {
            const config: PlannerConfig = {
                targetSemester: "2025-fall",
                maxCourses: 5,
                maxCredits: 18,
                targetGraduation: "2027-spring",
            };
            const plan = planNextSemester(student, program, courses, prereqs, config);
            return {
                semester: plan.targetSemester,
                courses: plan.suggestions.map(s => ({
                    id: s.courseId,
                    title: s.title,
                    credits: s.credits,
                    category: s.category,
                })),
                totalCredits: plan.plannedCredits,
                freeSlots: plan.freeSlots,
                pacingNote: undefined,
                enrollmentWarnings: plan.enrollmentWarnings,
            };
        },
    };
}

// ---- Main Runner ----
async function main() {
    console.log("=".repeat(60));
    console.log("  Advisory Quality Evaluation — Layer C (§5.4)");
    console.log("=".repeat(60));
    console.log(`  Scenarios: ${SCENARIOS.length}`);
    console.log(`  Judge model: gpt-4o-mini`);
    console.log("=".repeat(60));

    const llm = createOpenAIClient();
    const results: Array<{
        id: string;
        query: string;
        response: string;
        claims: JudgeClaim[];
        tone: string;
        toneNote: string;
    }> = [];

    for (const scenario of SCENARIOS) {
        console.log(`\n📝 ${scenario.id}: "${scenario.query}"`);

        const student = loadProfile(scenario.profileName);
        const context = buildContext(student, csProgram);

        // Step 1: Get chatbot response
        console.log("   ⏳ Generating chatbot response...");
        let response: string;
        try {
            const chatResult = await handleMessage(scenario.query, context, llm);
            response = chatResult.message;
            console.log(`   ✅ Response (${response.length} chars, intent: ${chatResult.intent.intent})`);
        } catch (err) {
            console.log(`   ❌ Error generating response: ${err}`);
            response = `[ERROR: ${err}]`;
        }

        // Step 2: Build ground truth
        const groundTruth = scenario.getGroundTruth(student, csProgram);

        // Step 3: Run judge
        console.log("   ⏳ Running judge...");
        let judgeResult: JudgeResult;
        try {
            const judgePrompt = buildJudgePrompt(scenario.query, response, groundTruth);
            judgeResult = await llm.chatJSON<JudgeResult>([
                { role: "system", content: JUDGE_SYSTEM_PROMPT },
                { role: "user", content: judgePrompt },
            ], { model: "gpt-4o-mini", temperature: 0 });
            console.log(`   ✅ Judge extracted ${judgeResult.claims.length} claims`);
        } catch (err) {
            console.log(`   ❌ Judge error: ${err}`);
            judgeResult = { claims: [], tone: "appropriate" };
        }

        // Log claim labels
        for (const claim of judgeResult.claims) {
            const icon = claim.label === "grounded" ? "✅" :
                claim.label === "hallucinated" ? "🔴" :
                    claim.label === "contradicted" ? "⛔" : "⚠️";
            console.log(`      ${icon} [${claim.label}] ${claim.text.slice(0, 80)}...`);
        }

        results.push({
            id: scenario.id,
            query: scenario.query,
            response,
            claims: judgeResult.claims,
            tone: judgeResult.tone,
            toneNote: judgeResult.toneNote ?? "",
        });
    }

    // ---- Generate calibration CSV ----
    const csvRows: string[] = [
        "scenario_id,query,claim_text,judge_label,human_label,evidence,notes",
    ];

    for (const r of results) {
        for (const claim of r.claims) {
            const escapeCsv = (s: string) =>
                `"${s.replace(/"/g, '""').replace(/\n/g, " ")}"`;
            csvRows.push([
                escapeCsv(r.id),
                escapeCsv(r.query),
                escapeCsv(claim.text),
                escapeCsv(claim.label),
                "",  // human_label — blank for human to fill
                escapeCsv(claim.evidence),
                "",  // notes — blank for human
            ].join(","));
        }
    }

    const csvPath = join(__dirname, "calibration_sheet.csv");
    writeFileSync(csvPath, csvRows.join("\n"), "utf-8");
    console.log(`\n📄 Calibration sheet: ${csvPath}`);
    console.log(`   Total claims: ${csvRows.length - 1}`);

    // ---- Generate full responses file (for reference) ----
    const responsesPath = join(__dirname, "advisory_responses.json");
    writeFileSync(responsesPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`📄 Full responses: ${responsesPath}`);

    // ---- Summary stats ----
    const allClaims = results.flatMap(r => r.claims);
    const labelCounts: Record<string, number> = {};
    for (const c of allClaims) {
        labelCounts[c.label] = (labelCounts[c.label] || 0) + 1;
    }

    console.log("\n" + "=".repeat(60));
    console.log("  PRELIMINARY JUDGE RESULTS (pre-calibration)");
    console.log("=".repeat(60));
    console.log(`  Total claims: ${allClaims.length}`);
    for (const [label, count] of Object.entries(labelCounts)) {
        const pct = ((count / allClaims.length) * 100).toFixed(1);
        console.log(`    ${label}: ${count} (${pct}%)`);
    }

    const groundingRate = (labelCounts["grounded"] || 0) / allClaims.length;
    const hallucinationRate = (labelCounts["hallucinated"] || 0) / allClaims.length;
    const contradictionRate = (labelCounts["contradicted"] || 0) / allClaims.length;
    const toneAppropriate = results.filter(r => r.tone === "appropriate").length / results.length;

    console.log(`\n  Grounding Rate:      ${(groundingRate * 100).toFixed(1)}% (target: ≥95%)`);
    console.log(`  Hallucination Rate:  ${(hallucinationRate * 100).toFixed(1)}% (target: ≤3%)`);
    console.log(`  Contradiction Rate:  ${(contradictionRate * 100).toFixed(1)}% (target: 0%)`);
    console.log(`  Tone Appropriate:    ${(toneAppropriate * 100).toFixed(1)}% (target: ≥95%)`);

    // Median response length (tokens ≈ words * 1.3)
    const lengths = results.map(r => r.response.split(/\s+/).length);
    lengths.sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)];
    console.log(`  Median Response:     ~${median} words (~${Math.round(median * 1.3)} tokens, target: 100-300)`);

    console.log("\n" + "=".repeat(60));
    console.log("  NEXT STEP: Open calibration_sheet.csv and fill 'human_label'");
    console.log("  Then run: npx tsx cohensKappa.ts");
    console.log("=".repeat(60));
}

main().catch(console.error);
