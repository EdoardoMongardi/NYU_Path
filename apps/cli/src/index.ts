#!/usr/bin/env tsx
// ============================================================
// NYUPath CLI — Degree Audit Tool
// ============================================================
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StudentProfile, AuditResult, SemesterPlan } from "@nyupath/shared";
import { degreeAudit, planNextSemester, loadCourses, loadProgram } from "@nyupath/engine";
import { loadPrereqs } from "@nyupath/engine";

function main() {
    const args = process.argv.slice(2);

    if (args[0] === "audit") {
        const studentPath = getArg(args, "--student");
        const programId = getArg(args, "--program") ?? undefined;

        if (!studentPath) {
            console.error("Usage: nyupath audit --student <path.json> [--program <programId>]");
            process.exit(1);
        }

        const student = loadStudent(studentPath);
        const courses = loadCourses();
        const targetProgramId = programId ?? student.declaredPrograms[0];

        if (!targetProgramId) {
            console.error("Error: No program specified and student has no declared programs.");
            process.exit(1);
        }

        const program = loadProgram(targetProgramId, student.catalogYear);
        if (!program) {
            console.error(
                `Error: Program "${targetProgramId}" (catalog year ${student.catalogYear}) not found.`
            );
            process.exit(1);
        }

        const result = degreeAudit(student, program, courses);
        printAuditResult(result);
    } else if (args[0] === "plan") {
        const studentPath = getArg(args, "--student");
        const semester = getArg(args, "--semester");
        const programId = getArg(args, "--program") ?? undefined;
        const maxCourses = parseInt(getArg(args, "--max-courses") ?? "5", 10);
        const maxCredits = parseInt(getArg(args, "--max-credits") ?? "18", 10);

        if (!studentPath || !semester) {
            console.error("Usage: nyupath plan --student <path.json> --semester <YYYY-term>");
            console.error("  Options: --program <id> --max-courses <n> --max-credits <n>");
            process.exit(1);
        }

        const student = loadStudent(studentPath);
        const courses = loadCourses();
        const prereqs = loadPrereqs();
        const targetProgramId = programId ?? student.declaredPrograms[0];

        if (!targetProgramId) {
            console.error("Error: No program specified and student has no declared programs.");
            process.exit(1);
        }

        const program = loadProgram(targetProgramId, student.catalogYear);
        if (!program) {
            console.error(`Error: Program "${targetProgramId}" not found.`);
            process.exit(1);
        }

        const plan = planNextSemester(student, program, courses, prereqs, {
            targetSemester: semester,
            maxCourses,
            maxCredits,
        });
        printPlanResult(plan);
    } else {
        console.log("NYUPath — Degree Planning CLI");
        console.log("");
        console.log("Commands:");
        console.log("  audit --student <path.json>             Run degree audit");
        console.log("  plan  --student <path.json> --semester <YYYY-term>  Plan next semester");
        console.log("");
        console.log("Options:");
        console.log("  --program <id>       Override program");
        console.log("  --max-courses <n>    Max courses per semester (default: 5)");
        console.log("  --max-credits <n>    Max credits per semester (default: 18)");
    }
}

function loadStudent(path: string): StudentProfile {
    const raw = readFileSync(resolve(path), "utf-8");
    return JSON.parse(raw) as StudentProfile;
}

function getArg(args: string[], flag: string): string | null {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) return null;
    return args[idx + 1];
}

function printAuditResult(result: AuditResult) {
    const statusIcon = (s: string) =>
        s === "satisfied" ? "✅" : s === "in_progress" ? "🔶" : "⬜";

    console.log("");
    console.log(`${"═".repeat(60)}`);
    console.log(`  NYUPath Degree Audit`);
    console.log(`${"═".repeat(60)}`);
    console.log(`  Program:      ${result.programName}`);
    console.log(`  Catalog Year: ${result.catalogYear}`);
    console.log(`  Student:      ${result.studentId}`);
    console.log(`  Credits:      ${result.totalCreditsCompleted} / ${result.totalCreditsRequired}`);
    console.log(`  Overall:      ${statusIcon(result.overallStatus)} ${result.overallStatus.toUpperCase()}`);
    console.log(`${"─".repeat(60)}`);
    console.log("");

    for (const rule of result.rules) {
        console.log(`  ${statusIcon(rule.status)} ${rule.label}`);
        if (rule.coursesSatisfying.length > 0) {
            console.log(`     Completed: ${rule.coursesSatisfying.join(", ")}`);
        }
        if (rule.remaining > 0) {
            console.log(`     Remaining: ${rule.remaining} more needed`);
            if (rule.coursesRemaining.length > 0 && rule.coursesRemaining.length <= 6) {
                console.log(`     Options:   ${rule.coursesRemaining.join(", ")}`);
            }
        }
        console.log("");
    }

    if (result.warnings.length > 0) {
        console.log(`${"─".repeat(60)}`);
        console.log("  ⚠️  Warnings:");
        for (const w of result.warnings) {
            console.log(`     • ${w}`);
        }
        console.log("");
    }

    console.log(`${"═".repeat(60)}`);
}

function printPlanResult(plan: SemesterPlan) {
    const riskIcon = (level: string) =>
        level === "critical" ? "🔴" : level === "high" ? "🟠" : level === "medium" ? "🟡" : "🟢";

    console.log("");
    console.log(`${"═".repeat(60)}`);
    console.log(`  NYUPath Semester Plan`);
    console.log(`${"═".repeat(60)}`);
    console.log(`  Student:    ${plan.studentId}`);
    console.log(`  Semester:   ${plan.targetSemester}`);
    console.log(`  Semesters Left: ~${plan.estimatedSemestersLeft}`);
    console.log(`  Planned Credits: ${plan.plannedCredits}`);
    console.log(`  Projected Total: ${plan.projectedTotalCredits}`);
    console.log(`${"─".repeat(60)}`);
    console.log("");

    if (plan.suggestions.length === 0) {
        console.log("  No course suggestions available for this term.");
    } else {
        console.log("  📋 Recommended Courses (by priority):");
        console.log("");
        for (let i = 0; i < plan.suggestions.length; i++) {
            const s = plan.suggestions[i];
            console.log(`  ${i + 1}. ${s.courseId} — ${s.title}`);
            console.log(`     Credits: ${s.credits} | Priority: ${s.priority} | Unlocks: ${s.blockedCount} course(s)`);
            console.log(`     Reason: ${s.reason}`);
            if (s.satisfiesRules.length > 0) {
                console.log(`     Satisfies: ${s.satisfiesRules.join(", ")}`);
            }
            console.log("");
        }
    }

    if (plan.risks.length > 0) {
        console.log(`${"─".repeat(60)}`);
        console.log("  ⚠️  Graduation Risks:");
        for (const risk of plan.risks) {
            console.log(`     ${riskIcon(risk.level)} [${risk.level.toUpperCase()}] ${risk.message}`);
        }
        console.log("");
    }

    console.log(`${"═".repeat(60)}`);
}

main();
