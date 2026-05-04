// ============================================================
// packages/engine/scripts/verifyForwardDegreeFix.ts
// ============================================================
// End-to-end self-test for the May 2026 post-mortem fixes:
//   - RC-1 systemPrompt routing
//   - RC-2 responseValidator gate
//   - RC-3 agentStatusVerbs map
//   - RC-5 draft-plan SSE
//   - plan_semester deprecation
//
// Drives `runAgentTurnStreaming` directly with a real Anthropic LLM
// client, using the SAA_STD_DS.pdf DPR fixture from the repo root.
// Reports which tools fired and whether `session.forwardSchedule`
// (or `studentDraftPlan`) ended up populated — the key invariant
// that the schedule-sidebar SSE depends on.
//
// Run from repo root:
//   node --import tsx ./packages/engine/scripts/verifyForwardDegreeFix.ts
//
// Costs ~$0.10–0.30 per run.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import {
    buildDefaultRegistry,
    buildSystemPrompt,
    createPrimaryClient,
    runAgentTurnStreaming,
    type ToolSession,
} from "../src/agent/index.js";
import { parseDpr } from "../src/dpr/index.js";
import type { CourseTaken, ProgramDeclaration, StudentProfile } from "@nyupath/shared";
import type { DegreeProgressReport } from "../src/dpr/index.js";
import { extractText } from "unpdf";

// Minimal student-profile builder from a parsed DPR. This is a stripped-down
// version of `apps/web/lib/buildSession.ts:buildStudentProfileFromDpr` —
// inlined here so the harness has zero cross-package import dependencies.
function buildStudentFromDpr(report: DegreeProgressReport, opts: { visaStatus?: "f1" | "domestic" } = {}): StudentProfile {
    const coursesTaken: CourseTaken[] = [];
    const pendingCourses: Array<{ courseId: string; title: string; credits: number }> = [];
    let currentTerm: string | undefined;
    for (const row of report.courseHistory) {
        if (row.subject === "ELECTIVE") continue;
        const courseId = `${row.subject} ${row.catalogNbr}`.replace(/\s+/g, " ").trim();
        const grade = row.grade ?? (row.type === "IP" ? "C" : "P");
        coursesTaken.push({ courseId, grade, semester: row.term, credits: row.units });
        if (row.type === "IP") {
            pendingCourses.push({ courseId, title: row.courseTitle, credits: row.units });
            if (!currentTerm) currentTerm = row.term;
        }
    }
    const declaredPrograms: ProgramDeclaration[] = [
        { programId: "cs_major_ba", programType: "major" },
    ];
    const transferRows = report.courseHistory.filter((r) => r.type === "TE");
    const genericTransferCredits = transferRows.reduce((sum, r) => sum + r.units, 0);
    return {
        id: "verify-script",
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms,
        coursesTaken,
        genericTransferCredits,
        flags: [],
        visaStatus: opts.visaStatus ?? "domestic",
        currentSemester: pendingCourses.length > 0
            ? { term: currentTerm ?? "current", courses: pendingCourses }
            : undefined,
    };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");

// override: true — the shell may already have an empty ANTHROPIC_API_KEY
// inherited from a Claude Code session; force the .env.local value to win.
dotenv.config({ path: path.join(REPO_ROOT, "apps/web/.env.local"), override: true });
if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY missing from apps/web/.env.local");
    process.exit(1);
}

const DPR_PATH = path.join(REPO_ROOT, "SAA_STD_DS.pdf");
if (!fs.existsSync(DPR_PATH)) {
    console.error(`DPR fixture not found at ${DPR_PATH}`);
    process.exit(1);
}

async function main() {
    console.log("=".repeat(70));
    console.log("Phase 15 + RC-1..5 + plan_semester deprecation verification");
    console.log("=".repeat(70));

    console.log("\n[1] Parsing DPR PDF…");
    const buf = fs.readFileSync(DPR_PATH);
    const { text } = await extractText(new Uint8Array(buf));
    const flatText = Array.isArray(text) ? text.join("\n") : text;
    const parsed = parseDpr(flatText);
    if (!parsed.ok) {
        console.error("Failed to parse DPR:", parsed);
        process.exit(1);
    }
    const dpr = parsed.report;
    console.log(`    OK — ${dpr.courseHistory.length} course rows, ${dpr.programs?.length ?? 0} programs`);

    console.log("\n[2] Building session…");
    const student = buildStudentFromDpr(dpr, { visaStatus: "f1" });
    const session: ToolSession = {
        student,
        degreeProgressReport: dpr,
    };
    console.log(`    OK — student.id=${student.id}, homeSchool=${student.homeSchool}, programs=${student.declaredPrograms.length}`);
    console.log(`    visaStatus=${student.visaStatus}, catalogYear=${student.catalogYear}`);

    const primary = createPrimaryClient();
    if (!primary) {
        console.error("createPrimaryClient returned null — provider env not configured");
        process.exit(1);
    }
    console.log(`\n[3] Primary client: ${primary.id}`);
    const registry = buildDefaultRegistry();
    const registeredNames = registry.list().map((t) => t.name).sort();
    console.log(`    Registry has ${registeredNames.length} tools.`);
    if (registeredNames.includes("plan_semester")) {
        console.error("    REGRESSION: plan_semester is still registered. Aborting.");
        process.exit(1);
    }
    console.log("    plan_semester correctly NOT registered ✓");

    const userMessage = "What should I take next semester? Please plan my full degree through graduation.";
    console.log(`\n[4] Sending user message:\n    "${userMessage}"`);

    const systemPrompt = buildSystemPrompt({
        student,
        dprLoaded: true,
        graduationTerm: "Spring 2027",
    });

    const beforeForwardComputedAt = session.forwardSchedule?.computedAt;
    const beforeDraftComputedAt = session.studentDraftPlan?.computedAt;

    const toolCalls: Array<{ name: string; summary?: string; error?: string }> = [];
    const tokens: string[] = [];
    let finalResult: any = null;

    for await (const ev of runAgentTurnStreaming(primary, registry, session, userMessage, {
        systemPrompt,
        maxTurns: 10,
    })) {
        if (ev.type === "tool_invocation_start") {
            console.log(`    [tool_start] ${ev.toolName}`);
        } else if (ev.type === "tool_invocation_done") {
            const inv = ev.invocation;
            toolCalls.push({
                name: inv.toolName,
                summary: inv.summary,
                error: inv.error?.message,
            });
            console.log(`    [tool_done]  ${inv.toolName}${inv.error ? "  ERROR: " + inv.error.message : "  ok"}`);
        } else if (ev.type === "text_delta") {
            tokens.push(ev.text);
        } else if (ev.type === "done") {
            finalResult = ev.result;
        }
    }

    console.log("\n" + "=".repeat(70));
    console.log("RESULTS");
    console.log("=".repeat(70));

    console.log(`\nfinal kind: ${finalResult?.kind}`);
    console.log(`tool calls (${toolCalls.length}):`);
    for (const tc of toolCalls) {
        console.log(`  - ${tc.name}${tc.error ? " [ERROR: " + tc.error + "]" : ""}`);
    }

    const calledForward = toolCalls.some((c) => c.name === "plan_forward_degree");
    const calledLegacy = toolCalls.some((c) => c.name === "plan_semester");
    const calledViewForward = toolCalls.some((c) => c.name === "view_forward_plan");

    const afterForwardComputedAt = session.forwardSchedule?.computedAt;
    const afterDraftComputedAt = session.studentDraftPlan?.computedAt;
    const forwardSet = afterForwardComputedAt !== undefined && beforeForwardComputedAt !== afterForwardComputedAt;
    const draftSet = afterDraftComputedAt !== undefined && beforeDraftComputedAt !== afterDraftComputedAt;

    console.log(`\nsession.forwardSchedule set this turn:    ${forwardSet}`);
    console.log(`session.studentDraftPlan set this turn:   ${draftSet}`);

    if (session.forwardSchedule) {
        console.log(`forwardSchedule.state:                    ${session.forwardSchedule.state}`);
        console.log(`forwardSchedule.semesters.length:         ${session.forwardSchedule.semesters.length}`);
    }
    if (session.studentDraftPlan) {
        console.log(`studentDraftPlan.state:                   ${session.studentDraftPlan.state}`);
        console.log(`studentDraftPlan.semesters.length:        ${session.studentDraftPlan.semesters.length}`);
    }

    console.log("\nfinal reply (first 500 chars):");
    const reply = tokens.join("");
    console.log(reply.slice(0, 500) + (reply.length > 500 ? "…" : ""));

    console.log("\n" + "=".repeat(70));
    console.log("VERDICT");
    console.log("=".repeat(70));
    if (calledLegacy) {
        console.log("FAIL — plan_semester was called (it is supposed to be deregistered).");
        process.exit(2);
    }
    if (!calledForward && !calledViewForward) {
        console.log("FAIL — neither plan_forward_degree nor view_forward_plan was called.");
        console.log("       The system-prompt routing change isn't producing the expected behavior.");
        process.exit(2);
    }
    if (!forwardSet && !draftSet) {
        console.log("FAIL — plan_forward_degree was called but no schedule was stored.");
        console.log("       Sidebar SSE event would NOT fire.");
        process.exit(2);
    }
    console.log("PASS — Phase 13 forward planner fired AND schedule was stored. Sidebar SSE would emit.");
    if (calledForward && forwardSet) {
        console.log("       (Live `forwardSchedule` path — sidebar shows valid schedule.)");
    } else if (calledForward && draftSet) {
        console.log("       (`studentDraftPlan` path — sidebar shows infeasible-draft banner per RC-5.)");
    } else if (calledViewForward) {
        console.log("       (Used view_forward_plan from a previously-staged plan.)");
    }
}

main().catch((err) => {
    console.error("\nUnhandled error:", err);
    process.exit(1);
});
