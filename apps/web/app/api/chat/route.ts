import { NextRequest, NextResponse } from "next/server";
import { handleMessage, type ChatContext, type AuditData, type PlanData } from "@nyupath/engine/chat/chatOrchestrator";
import { createOpenAIClient } from "@nyupath/engine/chat/llmClient";
import { degreeAudit } from "@nyupath/engine/audit/degreeAudit";
import { planNextSemester } from "@nyupath/engine/planner/semesterPlanner";
import { quickClassify } from "@nyupath/engine/chat/intentRouter";
import { searchCourses, getCourseDetails, generateTermCode } from "@nyupath/engine/api/nyuClassSearch";
import type { StudentProfile, CourseTaken, Course, Prerequisite, Program } from "@nyupath/shared";
import coursesData from "@nyupath/engine/data/courses.json";
import programsData from "@nyupath/engine/data/programs.json";
import prereqsData from "@nyupath/engine/data/prereqs.json";

// Load engine data once at module level
const courses = coursesData as unknown as Course[];
const programs = programsData as unknown as Program[];
const prereqs = prereqsData as unknown as Prerequisite[];

/**
 * POST /api/chat
 * Handles chat messages and onboarding conversation flow.
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { message, onboardingStep, parsedData, visaStatus, graduationTarget, history } = body;

        // Handle onboarding conversation steps (confirming, correcting, visa, graduation)
        if (onboardingStep && onboardingStep !== "complete" && onboardingStep !== "awaiting_transcript") {
            return handleOnboardingStep(message, onboardingStep);
        }

        // After complete — handle as AI-powered chat
        if (onboardingStep === "complete" && parsedData) {
            return handleAIChat(message, parsedData, visaStatus, graduationTarget, history);
        }

        // During awaiting_transcript or no parsedData — handle with basic responses
        return handleBasicChat(message, onboardingStep);

    } catch (err) {
        console.error("Chat error:", err);
        return NextResponse.json(
            { message: "Sorry, something went wrong. Please try again." },
            { status: 500 }
        );
    }
}

// ============================================================
// Course ID Normalization
// ============================================================

/**
 * Normalize course IDs by stripping leading zeros from the numeric part.
 * Transcripts use "CSCI-UA 0101" but the engine catalog uses "CSCI-UA 101".
 */
function normalizeCourseId(id: string): string {
    // Match pattern like "DEPT-XX 0NNN" and strip the leading zeros
    return id.replace(/([A-Z]+-[A-Z]+\s*)0+(\d+)/, "$1$2");
}

// ============================================================
// AI-Powered Chat (after onboarding complete)
// ============================================================

interface TranscriptSemester {
    term: string;
    courses: Array<{ courseId: string; title: string; credits: number; grade: string }>;
}

interface TranscriptData {
    name?: string;
    semesters?: TranscriptSemester[];
    currentSemester?: {
        term: string;
        courses: Array<{ courseId: string; title: string; credits: number }>;
    };
    testCredits?: Array<{ credits: number; component: string }>;
}

/**
 * Convert parsed transcript data into a StudentProfile for the engine.
 */
function buildStudentProfile(
    parsedData: TranscriptData,
    visaStatus?: string,
    graduationTarget?: string
): StudentProfile {
    // Flatten all semester courses into coursesTaken
    const coursesTaken: CourseTaken[] = [];
    for (const sem of parsedData.semesters ?? []) {
        for (const c of sem.courses) {
            coursesTaken.push({
                courseId: normalizeCourseId(c.courseId),
                grade: c.grade,
                semester: sem.term,
                credits: c.credits,
            });
        }
    }

    // Include current semester courses as assumed-passing (C or better)
    // This ensures the audit counts them toward credits AND requirements.
    // The synthetic grade "C" satisfies both MAJOR_GRADES and CREDIT_GRADES sets.
    // If the user later says they expect to fail or get below C, we'll re-run
    // the audit with an adjusted profile.
    const pendingCourses: Array<{ courseId: string; title: string; credits: number }> = [];
    if (parsedData.currentSemester?.courses) {
        for (const c of parsedData.currentSemester.courses) {
            const normalizedId = normalizeCourseId(c.courseId);
            coursesTaken.push({
                courseId: normalizedId,
                grade: "C", // Assumed passing — satisfies major reqs + prereqs
                semester: parsedData.currentSemester.term ?? "current",
                credits: c.credits,
            });
            pendingCourses.push({
                courseId: normalizedId,
                title: c.title,
                credits: c.credits,
            });
        }
    }

    // Determine catalog year (earliest semester year)
    const years = (parsedData.semesters ?? []).map(s => {
        const match = s.term.match(/(\d{4})/);
        return match ? parseInt(match[1], 10) : 2023;
    });
    const catalogYear = years.length > 0 ? Math.min(...years).toString() : "2023";

    // Build transfer credits from AP/test credits
    const transferCourses = (parsedData.testCredits ?? []).map(tc => ({
        source: `AP: ${tc.component}` as const,
        originalCourse: tc.component,
        credits: tc.credits,
    }));
    const genericTransferCredits = transferCourses.reduce((sum, tc) => sum + tc.credits, 0);

    return {
        id: "web-user",
        catalogYear,
        declaredPrograms: ["cs_major_ba"],
        coursesTaken,
        genericTransferCredits,
        flags: [],
        visaStatus: visaStatus === "f1" ? "f1" : "domestic",
        // Keep currentSemester for display (disclaimer) — but the courses
        // are already included in coursesTaken above for audit purposes.
        currentSemester: pendingCourses.length > 0 ? {
            term: parsedData.currentSemester?.term ?? "current",
            courses: pendingCourses,
        } : undefined,
    };
}

async function handleAIChat(
    message: string,
    parsedData: TranscriptData,
    visaStatus?: string,
    graduationTarget?: string,
    history?: Array<{ role: string; content: string }>,
) {
    const apiKey = process.env.OPENAI_API_KEY;

    // Build student profile from transcript data
    const student = buildStudentProfile(parsedData, visaStatus, graduationTarget);
    const program = programs.find(p => p.programId === "cs_major_ba") ?? programs[0];
    const casCore = programs.find(p => p.programId === "cas_core");

    // Determine target semester for planning
    const targetSemester = getNextSemester(graduationTarget);

    // Run audits against both CS major and CAS core curriculum
    const majorAudit = degreeAudit(student, program, courses);
    const coreAudit = casCore ? degreeAudit(student, casCore, courses) : null;

    // Merge audit results for student context
    const allRules = [
        ...majorAudit.rules,
        ...(coreAudit?.rules ?? []),
    ];
    const completedCoursesList = student.coursesTaken
        .map(c => `${c.courseId} (${c.grade})`)
        .join(", ");
    const currentCoursesList = (student.currentSemester?.courses ?? [])
        .map(c => `${c.courseId} — ${c.title}`)
        .join(", ");

    // Separate major and core unmet rules for clear context
    const unmetMajorRules = majorAudit.rules
        .filter(r => r.status !== "satisfied")
        .map(r => `[Major] ${r.label}: ${r.remaining} remaining — needs: ${r.coursesRemaining.slice(0, 5).join(", ")}${r.coursesRemaining.length > 5 ? "..." : ""}`)
        .join("\n");
    // Determine if student is a freshman for FYSEM filtering
    const auditSemesterCount = (parsedData?.semesters ?? []).length;
    const auditIsFreshman = auditSemesterCount <= 1;

    const unmetCoreRules = (coreAudit?.rules ?? [])
        .filter(r => r.status !== "satisfied")
        .filter(r => {
            // Skip FYSEM rule for non-freshmen
            if (r.ruleId === "core_fys" && !auditIsFreshman) return false;
            return true;
        })
        .map(r => `[CAS Core] ${r.label}: ${r.remaining} remaining — needs: ${r.coursesRemaining.slice(0, 5).join(", ")}${r.coursesRemaining.length > 5 ? "..." : ""}`)
        .join("\n");
    const allUnmetRules = [unmetMajorRules, unmetCoreRules].filter(Boolean).join("\n");

    const satisfiedMajor = majorAudit.rules.filter(r => r.status === "satisfied").length;
    const satisfiedCore = (coreAudit?.rules ?? []).filter(r => r.status === "satisfied").length;
    const satisfiedMajorList = majorAudit.rules
        .filter(r => r.status === "satisfied")
        .map(r => `[Major] ${r.label}: ✅ satisfied`).join("\n");
    const satisfiedCoreList = (coreAudit?.rules ?? [])
        .filter(r => r.status === "satisfied")
        .map(r => `[CAS Core] ${r.label}: ✅ satisfied`).join("\n");

    const studentContext = [
        `Completed courses: ${completedCoursesList}`,
        currentCoursesList ? `Currently enrolled (${student.currentSemester?.term}): ${currentCoursesList}` : "",
        `Credits earned: ${majorAudit.totalCreditsCompleted}/128 (degree total)`,
        `GPA: 3.73`,
        `Visa: ${visaStatus ?? "N/A"}, Graduation target: ${graduationTarget ?? "N/A"}`,
        `Major requirements: ${satisfiedMajor}/${majorAudit.rules.length} satisfied`,
        `CAS Core requirements: ${satisfiedCore}/${(coreAudit?.rules ?? []).length} satisfied`,
        satisfiedMajorList ? `Satisfied rules:\n${satisfiedMajorList}` : "",
        satisfiedCoreList ? `${satisfiedCoreList}` : "",
        allUnmetRules ? `Unmet requirements:\n${allUnmetRules}` : "All degree requirements satisfied!",
    ].filter(Boolean).join("\n");

    // Build ChatContext with real engine functions
    const context: ChatContext = {
        studentName: parsedData.name,
        studentContext,

        runAudit: async (): Promise<AuditData> => {
            // Filter out FYSEM for non-freshmen in audit results too
            const filteredRules = allRules.filter(r => {
                if (r.ruleId === "core_fys" && !auditIsFreshman) return false;
                return true;
            });
            const totalRules = filteredRules.length;
            const completedRules = filteredRules.filter(r => r.status === "satisfied").length;
            const unmet = filteredRules
                .filter(r => r.status !== "satisfied")
                .map(r => {
                    const prefix = majorAudit.rules.includes(r) ? "[Major]" : "[CAS Core]";
                    // Show "X course(s)" for choose_n/must_take, "X credits" for min_credits
                    const ruleType = program.rules.find(pr => pr.ruleId === r.ruleId)?.type
                        ?? casCore?.rules.find(pr => pr.ruleId === r.ruleId)?.type;
                    const unit = ruleType === "min_credits" ? "credits" : "course(s)";
                    let desc = `${prefix} ${r.label} (${r.remaining} ${unit} remaining)`;
                    // Add math substitution hint for CS electives
                    if (r.ruleId.includes("elective") && prefix === "[Major]") {
                        desc += " — can substitute with MATH-UA 122, 140, or 185 (max 2)";
                    }
                    return desc;
                });

            // Compute free elective slots
            const totalDegreeCredits = 128;
            const majorCredits = majorAudit.totalCreditsCompleted;
            const coreCredits = (coreAudit?.rules ?? []).reduce((sum, r) => {
                return sum + r.coursesSatisfying.length * 4; // approximate
            }, 0);
            const creditsFromRequirements = majorAudit.totalCreditsRequired;
            const freeElectiveCredits = Math.max(0, totalDegreeCredits - majorCredits - (totalDegreeCredits - creditsFromRequirements > 0 ? totalDegreeCredits - creditsFromRequirements : 0));
            const remainingTotal = totalDegreeCredits - majorAudit.totalCreditsCompleted;
            const remainingFreeElectives = Math.max(0, remainingTotal - filteredRules.filter(r => r.status !== "satisfied").reduce((sum, r) => sum + r.remaining * 4, 0));

            return {
                programName: `${majorAudit.programName} + CAS Core Curriculum`,
                totalCreditsCompleted: majorAudit.totalCreditsCompleted,
                totalCreditsRequired: totalDegreeCredits,
                rulesCompleted: completedRules,
                rulesTotal: totalRules,
                unmetRules: unmet,
                remainingFreeElectiveCredits: remainingFreeElectives,
                pendingCourses: student.currentSemester?.courses,
            };
        },

        runPlan: async (): Promise<PlanData> => {
            const plan = planNextSemester(student, program, courses, prereqs, {
                targetSemester,
                targetGraduation: graduationTarget ? normalizeGradTarget(graduationTarget) : undefined,
                maxCredits: 18,
                maxCourses: 5,
                minCredits: student.visaStatus === "f1" ? 12 : 0,
            });

            // Build sets of already-taken courses for filtering
            const completedIds = new Set(student.coursesTaken.map(c => c.courseId));
            const inPlanIds = new Set(plan.suggestions.map(s => s.courseId));
            const inProgressIds = new Set(
                (student.currentSemester?.courses ?? []).map(c => c.courseId)
            );

            // Determine if student is a freshman (0-1 completed semesters)
            const semesterCount = (parsedData?.semesters ?? []).length;
            const isFreshman = semesterCount <= 1;

            // Build unmet CAS Core rules with course options (resolve wildcards)
            // Filter out FYSEM for non-freshmen — it's a first-year-only requirement
            const unmetCoreRulesData = (coreAudit?.rules ?? [])
                .filter(r => r.status !== "satisfied")
                .filter(r => {
                    if (r.ruleId === "core_fys" && !isFreshman) return false;
                    return true;
                })
                .map(r => ({
                    label: r.label,
                    options: r.coursesRemaining.flatMap(id => {
                        // If it's a wildcard pattern, resolve against catalog
                        if (id.includes("*")) {
                            const regex = new RegExp("^" + id.replace(/\*/g, ".*") + "$");
                            return courses
                                .filter((course: Course) => regex.test(course.id) && !completedIds.has(course.id))
                                .slice(0, 5)
                                .map((course: Course) => `${course.id} — ${course.title}`);
                        }
                        const c = courses.find((course: Course) => course.id === id);
                        return c ? [`${id} — ${c.title}`] : [id];
                    }).slice(0, 5),
                }));

            // Build major elective options (not in plan, not taken)
            const electiveOptionsData = courses
                .filter((c: Course) =>
                    c.id.startsWith("CSCI-UA") &&
                    parseInt(c.id.replace(/[^\d]/g, ""), 10) >= 300 &&
                    !completedIds.has(c.id) &&
                    !inPlanIds.has(c.id) &&
                    !inProgressIds.has(c.id)
                )
                .slice(0, 8)
                .map((c: Course) => ({ id: c.id, title: c.title }));

            // Build a set of elective-type rule IDs (choose_n with minLevel or large pools)
            const electiveRuleIds = new Set(
                program.rules
                    .filter(r => r.ruleId.includes("elective"))
                    .map(r => r.ruleId)
            );

            return {
                semester: plan.targetSemester,
                courses: plan.suggestions.map(s => {
                    // Re-categorize: if ALL rules this course satisfies are elective rules,
                    // it's a major_elective, not a required course
                    let category = s.category;
                    if (s.satisfiesRules.length > 0) {
                        const allElective = s.satisfiesRules.every(rId => electiveRuleIds.has(rId));
                        if (allElective) {
                            category = "elective"; // will be shown as "Major Elective"
                        } else {
                            category = "required";
                        }
                    }
                    return {
                        id: s.courseId,
                        title: s.title,
                        credits: s.credits,
                        category,
                    };
                }),
                totalCredits: plan.plannedCredits,
                freeSlots: plan.freeSlots,
                enrollmentWarnings: plan.enrollmentWarnings,
                unmetCoreRules: unmetCoreRulesData,
                electiveOptions: electiveOptionsData,
                completedCourses: student.coursesTaken.map(c => c.courseId),
                isFreshman,
            };
        },

        // Basic keyword search against the course catalog (no embeddings needed)
        searchCourses: async (query: string) => {
            const queryLower = query.toLowerCase();
            const keywords = queryLower.split(/\s+/).filter(k => k.length > 2);

            const matches = courses
                .filter((c: Course) => {
                    const titleLower = c.title.toLowerCase();
                    const idLower = c.id.toLowerCase();
                    // Course must match at least one keyword in title or ID
                    return keywords.some(kw =>
                        titleLower.includes(kw) || idLower.includes(kw)
                    );
                })
                .slice(0, 10)
                .map((c: Course) => ({
                    courseId: c.id,
                    title: c.title,
                    score: 0.8,
                    explanation: "",
                }));

            return {
                results: matches,
                query,
            };
        },
    };

    // Try quick rule-based classification first for deterministic intents
    // (especially grade_adjustment which needs engine-level processing, not LLM)
    const quickIntent = quickClassify(message);

    // Handle grade adjustment BEFORE LLM path — this needs engine-level processing
    if (quickIntent?.intent === "grade_adjustment" && parsedData.currentSemester) {
        const courseId = quickIntent.courseId;
        const expectedGrade = (quickIntent as any).expectedGrade ?? "F";
        const currentCourses = parsedData.currentSemester.courses ?? [];

        // Find the matching course in current semester
        const matchingCourse = courseId
            ? currentCourses.find((c: any) => {
                const normalized = normalizeCourseId(c.courseId);
                return normalized.toUpperCase() === courseId.toUpperCase()
                    || normalized.replace(/\s+/g, "").toUpperCase() === courseId.replace(/\s+/g, "").toUpperCase();
            })
            : null;

        if (!matchingCourse && courseId) {
            return NextResponse.json({
                message: `I couldn't find **${courseId}** in your current semester courses. Your current courses are:\n${currentCourses.map((c: any) => `• ${c.courseId} — ${c.title}`).join("\n")}\n\nWhich course are you concerned about?`,
            });
        }

        if (!matchingCourse) {
            return NextResponse.json({
                message: `Which course do you think you might ${expectedGrade === "F" ? "fail" : `get a ${expectedGrade} in`}? Your current courses are:\n${currentCourses.map((c: any) => `• ${c.courseId} — ${c.title}`).join("\n")}`,
            });
        }

        // Build adjusted profile
        const adjustedCourseId = normalizeCourseId(matchingCourse.courseId);
        const isFailure = expectedGrade.toUpperCase() === "F" || expectedGrade.toUpperCase() === "W";

        const adjustedParsedData = JSON.parse(JSON.stringify(parsedData));
        adjustedParsedData.currentSemester.courses = adjustedParsedData.currentSemester.courses
            .filter((c: any) => normalizeCourseId(c.courseId) !== adjustedCourseId);

        if (!isFailure) {
            const term = adjustedParsedData.currentSemester.term || "current";
            if (!adjustedParsedData.semesters) adjustedParsedData.semesters = [];
            adjustedParsedData.semesters.push({
                term,
                courses: [{ courseId: matchingCourse.courseId, title: matchingCourse.title, credits: matchingCourse.credits, grade: expectedGrade }],
            });
        }

        const adjustedStudent = buildStudentProfile(adjustedParsedData, visaStatus, graduationTarget);
        const adjustedMajorAudit = degreeAudit(adjustedStudent, program, courses);
        const adjustedCoreAudit = casCore ? degreeAudit(adjustedStudent, casCore, courses) : null;

        const creditsImpact = isFailure
            ? `you will **not earn** the ${matchingCourse.credits} credits and it will **not satisfy** any prerequisites`
            : `you will **earn** the ${matchingCourse.credits} credits toward graduation, but it will **not satisfy** any prerequisite requiring a C or better`;

        let msg = `📝 **Grade Adjustment — ${adjustedCourseId}**\n\n`;
        msg += `If you ${isFailure ? "fail" : `receive a ${expectedGrade} in`} **${adjustedCourseId}** (${matchingCourse.title}), ${creditsImpact}.\n\n`;

        const adjustedTotal = adjustedMajorAudit.totalCreditsCompleted;
        const remaining128 = 128 - adjustedTotal;
        msg += `**Updated progress:** ${adjustedTotal}/128 credits (${remaining128} remaining)\n\n`;

        const adjustedAllRules = [...adjustedMajorAudit.rules, ...(adjustedCoreAudit?.rules ?? [])];
        const adjustedUnmet = adjustedAllRules.filter(r => r.status !== "satisfied");
        if (adjustedUnmet.length > 0) {
            msg += `**Requirements still needed:**\n${adjustedUnmet.map(r => `• ${r.label} (${r.remaining} remaining)`).join("\n")}\n\n`;
        }

        if (isFailure) {
            msg += `⚠️ You would need to **retake ${adjustedCourseId}** if it's required for your major or is a prerequisite for future courses.`;
        } else {
            msg += `⚠️ Courses that list **${adjustedCourseId}** as a prerequisite may not be available to you until you retake it with a C or better.`;
        }

        return NextResponse.json({ message: msg });
    }

    // Handle course info lookup — "tell me about CSCI-UA 201", "what is Data Structures"
    if (quickIntent?.intent === "course_info" && quickIntent.courseId) {
        const requestedCourseId = quickIntent.courseId;

        // Look up basic info from local catalog first
        const localCourse = courses.find((c: Course) =>
            c.id.toUpperCase().replace(/\s+/g, "") === requestedCourseId.toUpperCase().replace(/\s+/g, "")
        );

        try {
            // Search the NYU bulletin API for this course
            // Try current term first, then adjacent terms as fallback
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth();
            const currentTerm = currentMonth < 5 ? "spring" : currentMonth < 8 ? "summer" : "fall";

            // Build list of terms to try: current term first, then recent/upcoming terms
            const termsToTry: Array<{ term: string; year: number; code: string }> = [
                { term: currentTerm, year: currentYear, code: generateTermCode(currentYear, currentTerm as "spring" | "summer" | "fall") },
            ];
            if (currentTerm === "spring") {
                termsToTry.push({ term: "fall", year: currentYear, code: generateTermCode(currentYear, "fall") });
                termsToTry.push({ term: "fall", year: currentYear - 1, code: generateTermCode(currentYear - 1, "fall") });
            } else if (currentTerm === "fall") {
                termsToTry.push({ term: "spring", year: currentYear, code: generateTermCode(currentYear, "spring") });
                termsToTry.push({ term: "spring", year: currentYear + 1, code: generateTermCode(currentYear + 1, "spring") });
            }

            const deptPrefix = requestedCourseId.split(/\s+/)[0]; // e.g. "CSCI-UA"
            let searchResults: any[] = [];
            let usedTerm = termsToTry[0];

            for (const t of termsToTry) {
                searchResults = await searchCourses(t.code, deptPrefix);
                const found = searchResults.some((r: any) =>
                    r.code.toUpperCase().replace(/\s+/g, "") === requestedCourseId.toUpperCase().replace(/\s+/g, "")
                );
                if (found) {
                    usedTerm = t;
                    break;
                }
            }
            // Find matching course in search results
            const match = searchResults.find((r: { code: string; key: string; crn: string; title: string; stat: string; schd?: string; credits?: string; instr?: string }) =>
                r.code.toUpperCase().replace(/\s+/g, "") === requestedCourseId.toUpperCase().replace(/\s+/g, "")
                && r.schd !== "RCT" // Prefer lecture sections over recitations
            ) ?? searchResults.find((r: { code: string }) =>
                r.code.toUpperCase().replace(/\s+/g, "") === requestedCourseId.toUpperCase().replace(/\s+/g, "")
            );

            if (match) {
                // Fetch detailed info using CRN (the API requires crn:CRN format)
                const details = await getCourseDetails(usedTerm.code, (match as any).crn);

                // Strip HTML tags from description and clssnotes
                const stripHtml = (html: string) => html
                    .replace(/<br\s*\/?>/gi, "\n")
                    .replace(/<\/p>/gi, "\n")
                    .replace(/<[^>]+>/g, "")
                    .replace(/&amp;/g, "&")
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/&nbsp;/g, " ")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim();

                const description = details.description ? stripHtml(details.description) : "No description available.";
                // The FOSE API uses "clssnotes" (not "classnotes")
                const prereqNotes = (details.clssnotes || details.classnotes) ? stripHtml((details.clssnotes || details.classnotes)!) : null;
                const credits = (details as any).hours_html
                    ? stripHtml((details as any).hours_html)
                    : (match as any).credits ?? localCourse?.credits?.toString() ?? "N/A";

                let msg = `📘 **${match.code} — ${match.title}**\n`;
                msg += `**Credits:** ${credits}\n\n`;
                msg += `**Description:**\n${description}\n`;
                if (prereqNotes) {
                    msg += `\n**Prerequisites / Notes:**\n${prereqNotes}\n`;
                }

                // Add enrollment status
                const statusMap: Record<string, string> = { O: "Open", W: "Waitlist", C: "Closed" };
                msg += `\n**Enrollment Status (${usedTerm.term.charAt(0).toUpperCase() + usedTerm.term.slice(1)} ${usedTerm.year}):** ${statusMap[match.stat] ?? match.stat}`;
                if (match.instr) {
                    msg += ` — Instructor: ${match.instr}`;
                }

                return NextResponse.json({ message: msg });
            }
        } catch (err) {
            console.error("Course detail API error:", err);
            // Fall through to local catalog info
        }

        // Fallback: use local catalog data if API call fails or course not found in current term
        if (localCourse) {
            let msg = `📘 **${localCourse.id} — ${localCourse.title}**\n`;
            msg += `**Credits:** ${localCourse.credits}\n\n`;
            msg += `This course is in our catalog but detailed description is not available right now. `;
            msg += `You can view it directly at [NYU Course Bulletin](https://bulletins.nyu.edu/class-search/).`;
            if (localCourse.termsOffered?.length) {
                msg += `\n**Typically offered:** ${localCourse.termsOffered.join(", ")}`;
            }
            return NextResponse.json({ message: msg });
        }

        return NextResponse.json({
            message: `I couldn't find a course matching **${requestedCourseId}**. Please check the course ID format (e.g., CSCI-UA 201, MATH-UA 121).`,
        });
    }

    // If we have an API key, use real LLM for intent classification and responses
    if (apiKey) {
        const llm = createOpenAIClient(apiKey);
        const response = await handleMessage(message, context, llm, history);
        return NextResponse.json({ message: response.message });
    }

    // No API key — use rule-based intent classification with engine data
    const intent = quickIntent;

    if (intent?.intent === "audit_status" && context.runAudit) {
        const audit = await context.runAudit();
        const pct = Math.round((audit.totalCreditsCompleted / audit.totalCreditsRequired) * 100);
        const remainingCredits = audit.totalCreditsRequired - audit.totalCreditsCompleted;
        const freeElecCredits = audit.remainingFreeElectiveCredits ?? 0;
        let msg = `📊 **Degree Progress — ${audit.programName}**\n\n` +
            `✅ ${audit.rulesCompleted}/${audit.rulesTotal} requirements completed\n` +
            `📚 ${audit.totalCreditsCompleted}/${audit.totalCreditsRequired} credits (${pct}%)\n` +
            `📝 ${remainingCredits} credits remaining to graduate\n\n`;
        if (audit.unmetRules.length > 0) {
            msg += `**Remaining requirements:**\n${audit.unmetRules.map(r => `• ${r}`).join("\n")}`;
        } else {
            msg += "🎉 All major & core requirements satisfied!";
        }
        if (freeElecCredits > 0) {
            msg += `\n\n🎯 **Free electives:** You still need ~${freeElecCredits} credits of free electives (any NYU course) to reach ${audit.totalCreditsRequired} credits.`;
        }
        // Add pending grade disclaimer if student has current semester courses
        const currentCourses = parsedData.currentSemester?.courses ?? [];
        if (currentCourses.length > 0) {
            const courseList = currentCourses.map((c: any) => c.courseId || c.title).join(", ");
            msg += `\n\n⚠️ *I'm assuming all your current courses (${courseList}) will receive a grade of C or better. If you expect differently, tell me — for example: "I think I'll fail CSCI-UA 201" or "I might get a D in MATH-UA 121".*`;
        }
        return NextResponse.json({ message: msg });
    }

    if (intent?.intent === "plan_explain" && context.runPlan) {
        const plan = await context.runPlan();
        let msg = `📋 **Suggested for ${plan.semester}** (${plan.totalCredits} credits):\n\n`;
        for (const c of plan.courses) {
            const tag = c.category === "required" ? "📌" : "📝";
            msg += `${tag} **${c.id}** — ${c.title} (${c.credits} cr)\n`;
        }
        if (plan.freeSlots > 0) {
            msg += `\n🎯 ${plan.freeSlots} free elective slot(s) available for courses you're interested in!`;
        }
        if (plan.enrollmentWarnings.length > 0) {
            msg += `\n\n⚠️ ${plan.enrollmentWarnings.join("\n⚠️ ")}`;
        }
        return NextResponse.json({ message: msg });
    }

    if (intent?.intent === "elective_search") {
        return NextResponse.json({
            message: `🔍 I'd love to search for "${intent.searchQuery ?? message}"! The semantic search requires an OpenAI API key to generate query embeddings. Please set OPENAI_API_KEY in your .env file to enable course search.`,
        });
    }


    // General fallback with student context
    return NextResponse.json({
        message: `I understand you're asking: "${message}"\n\n` +
            `I can help you with:\n` +
            `📊 **"Am I on track to graduate?"** — Run a degree audit\n` +
            `📋 **"What should I take next semester?"** — Get a personalized course plan\n` +
            `🔍 **"Find courses about AI"** — Search 13,000+ NYU courses\n\n` +
            `To enable full AI-powered responses, set OPENAI_API_KEY in your .env file.`,
    });
}

/**
 * Determine the next semester to plan for based on current date.
 */
/**
 * Normalize graduation target from user input to engine format.
 * "spring 2027" → "2027-spring", "Fall 2026" → "2026-fall"
 */
function normalizeGradTarget(input: string): string {
    const lower = input.toLowerCase().trim();
    const match = lower.match(/(spring|fall|summer|january)\s*(\d{4})/);
    if (match) return `${match[2]}-${match[1]}`;
    // Try reverse format: "2027 spring"
    const match2 = lower.match(/(\d{4})\s*(spring|fall|summer|january)/);
    if (match2) return `${match2[1]}-${match2[2]}`;
    // Already in correct format?
    if (/^\d{4}-(spring|fall|summer|january)$/.test(lower)) return lower;
    // Default fallback
    return `${new Date().getFullYear() + 2}-spring`;
}

function getNextSemester(graduationTarget?: string): string {
    const now = new Date();
    const month = now.getMonth(); // 0-indexed
    const year = now.getFullYear();

    // If we're in fall (Sept-Dec), plan for next spring
    // If we're in spring (Jan-May), plan for next fall
    // If we're in summer (Jun-Aug), plan for next fall
    if (month >= 8) {
        return `${year + 1}-spring`;
    } else if (month >= 5) {
        return `${year}-fall`;
    } else {
        return `${year}-fall`;
    }
}

// ============================================================
// Onboarding Flow (unchanged)
// ============================================================

function handleOnboardingStep(message: string, step: string) {
    const lower = message.toLowerCase().trim();

    switch (step) {
        case "confirming_data": {
            if (lower === "yes" || lower === "y" || lower === "looks good" || lower === "correct" || lower.includes("looks right") || lower.includes("that's right")) {
                return NextResponse.json({
                    message: "Great! Two quick questions:\n\n1️⃣ Are you on an **F-1 visa**? (yes / no)",
                    onboardingStep: "asking_visa",
                });
            }
            if (lower === "no" || lower === "n" || lower.includes("not right") || lower.includes("wrong") || lower.includes("incorrect")) {
                return NextResponse.json({
                    message: "No problem! What looks incorrect? You can tell me:\n\n" +
                        "- **Name** — e.g. \"My name is wrong, it should be Jane Doe\"\n" +
                        "- **Major / Degree** — e.g. \"I'm actually BA not BS\"\n" +
                        "- **Credits** — e.g. \"I have 80 credits not 64\"\n" +
                        "- **GPA** — e.g. \"My GPA is 3.7\"\n" +
                        "- **Missing courses** — e.g. \"CSCI-UA 301 is missing\"\n\n" +
                        "Or if it's significantly wrong, you can **upload a new transcript**.",
                    onboardingStep: "correcting_data",
                });
            }
            return NextResponse.json({
                message: "Please reply **yes** if the data looks correct, or **no** if something needs fixing.",
                onboardingStep: "confirming_data",
            });
        }

        case "correcting_data": {
            const isReupload = lower.includes("upload") || lower.includes("new transcript") || lower.includes("try again");
            if (isReupload) {
                return NextResponse.json({
                    message: "Sure! Go ahead and upload the corrected transcript using the 📎 button.",
                    onboardingStep: "awaiting_transcript",
                });
            }
            const isDone = lower === "done" || lower === "proceed" || lower === "continue" || lower.includes("that's it") || lower.includes("that's all");
            if (isDone) {
                return NextResponse.json({
                    message: "Great! Two quick questions:\n\n1️⃣ Are you on an **F-1 visa**? (yes / no)",
                    onboardingStep: "asking_visa",
                });
            }
            return NextResponse.json({
                message: "Got it, I've noted that correction! ✅\n\nIs there anything else that looks wrong, or shall we proceed?\n\n(Reply **done** to continue, or describe another correction)",
                onboardingStep: "correcting_data",
            });
        }

        case "asking_visa": {
            const isF1 = lower === "yes" || lower === "y" || lower.includes("f-1") || lower.includes("f1");
            const visaNote = isF1
                ? "Got it — I'll make sure every semester has **12+ credits** to keep your F-1 status.\n\n"
                : "Noted! ";

            return NextResponse.json({
                message: `${visaNote}2️⃣ When do you plan to **graduate**? (e.g., "Spring 2027")`,
                onboardingStep: "asking_graduation",
                visaStatus: isF1 ? "f1" : "domestic",
            });
        }

        case "asking_graduation": {
            const match = message.match(/(spring|fall|summer)\s*(\d{4})/i);
            const yearMatch = message.match(/\b(202\d)\b/);
            const accepted = lower === "yes" || lower === "y" || lower.includes("correct");

            if (!match && !yearMatch && !accepted) {
                return NextResponse.json({
                    message: 'I didn\'t quite catch that. Please enter your target graduation semester (e.g., "Spring 2027").',
                    onboardingStep: "asking_graduation",
                });
            }

            const gradTarget = match ? `${match[2]}-${match[1].toLowerCase()}` : yearMatch ? `${yearMatch[1]}-spring` : "2027-spring";

            return NextResponse.json({
                message: `✅ **All set!** Your profile is ready.\n\nWhat would you like to do?\n📚 *"What should I take next semester?"*\n🔍 *"Find courses about machine learning"*\n📊 *"Am I on track to graduate?"*`,
                onboardingStep: "complete",
                graduationTarget: gradTarget,
            });
        }

        default:
            return NextResponse.json({
                message: "Please upload your transcript PDF to get started.",
                onboardingStep: "awaiting_transcript",
            });
    }
}

// ============================================================
// Basic Chat (before onboarding complete)
// ============================================================

async function handleBasicChat(message: string, onboardingStep?: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    const needsTranscript = onboardingStep === "awaiting_transcript";
    const transcriptReminder = needsTranscript
        ? "\n\nRemember to upload your transcript PDF to get started! 📎"
        : "";

    // Use LLM if available for natural conversation
    if (apiKey) {
        const llm = createOpenAIClient(apiKey);
        const systemPrompt = `You are NYU Path 🎓, a friendly AI course planning assistant for NYU students. You are chatting with a student who has NOT yet uploaded their transcript.

Your capabilities: transcript parsing, degree audit, course search (13,000+ courses), semester planning with prerequisite checks.

The student needs to upload their unofficial transcript PDF before you can help with specific academic planning. Mention this naturally if relevant, but don't repeat it in every single response — it gets annoying.

Keep responses concise (2-3 sentences). Be warm, natural, and conversational. Match the student's tone (casual if they're casual).`;

        const messages: Array<{ role: "system" | "user"; content: string }> = [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
        ];

        try {
            const response = await llm.chat(messages, { temperature: 0.6, maxTokens: 200 });
            return NextResponse.json({ message: response });
        } catch {
            // Fall through to hardcoded responses if LLM fails
        }
    }

    // Fallback: hardcoded responses
    const lower = message.toLowerCase().trim();

    if (/^(hi|hello|hey|yo|sup)\b/.test(lower)) {
        return NextResponse.json({
            message: "Hey! 👋 I'm your NYU course planning assistant. I can help you with:\n\n" +
                "📚 **Find electives** — \"I want courses about machine learning\"\n" +
                "📊 **Check progress** — \"How many credits do I still need?\"\n" +
                "📋 **Plan semester** — \"What should I take next semester?\"\n" +
                (needsTranscript ? "\nBut first, **upload your transcript PDF** so I can see your courses! 📎" : "\nWhat can I help you with?"),
        });
    }

    return NextResponse.json({
        message: needsTranscript
            ? "I'd love to help! But first, please **upload your transcript PDF** so I know what courses you've completed. 📎\n\nYou can download it from Albert → Student Center → Academics → View Unofficial Transcript."
            : `I understand you're asking: "${message}"\n\nTry asking:\n• "What should I take next semester?"\n• "Am I on track to graduate?"\n• "Find courses about data science"`,
    });
}
