// ============================================================
// D5.3 — Plan-claim agent-eval bucket (LAUNCH-BLOCKING exit clause)
// ============================================================
// Operationalizes the §10 exit clause "agent eval cases pass" for the
// plan-claim check (D5.1's `checkPlanClaims`, spread into
// `validateResponse`, wired on both route paths in D5.2).
//
// Two layers, mirroring preferenceExtraction.eval.ts:
//
//   PART 1 — deterministic fixture table + inline unconditional tests.
//     Runs on EVERY `npx vitest run` (vitest globs *.eval.ts), no API
//     key. THIS IS the operationalized exit-criterion gate: each fixture
//     asserts `checkPlanClaims` blocks (or does NOT block) the reply as
//     specified, plus a count-invariant (≥6 negatives, ≥8 positives).
//
//   PART 2 — ANTHROPIC_API_KEY-gated real-LLM false-positive safety net.
//     Prompts the REAL model to describe the FIXTURE plan in natural
//     adviser prose, then asserts the validator does NOT false-block the
//     model's phrasing. Gated so it never runs in CI (no API key). This
//     is the real-LLM net the D5.1 reviewers asked for.
//
// Tier note: plan claims are Tier-1 (engine-grounded). There is NO
// hedging exemption — "verify with your adviser" does NOT excuse an
// ungrounded placement / grad-term / lock-status claim.
// ============================================================

import { describe, expect, it } from "vitest";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import { validateResponse } from "../../src/agent/responseValidator.js";

// ============================================================
// FIXTURE_SCHEDULE — a minimal, valid ForwardSchedule
// ============================================================
// checkPlanClaims only reads `kind` + `courseId` per slot (and, for
// lock status, the slot kind + the semester's `locked`). The rich
// specific_planned / placeholder fields are irrelevant to the check,
// so we cast minimal shapes to ScheduleSlot (same approach as the D5.1
// unit test responseValidator.planClaims.test.ts).
//
//   CSCI-UA 102 → specific_planned (MOVABLE) in 2027-fall (unlocked)
//   CSCI-UA 101 → completed (LOCKED / final) in 2025-fall (locked)
//   CSCI-UA 201 → specific_planned (movable) in 2027-spring (unlocked)
//   graduationTerm → 2028-spring
// ============================================================

function plannedSlot(courseId: string): ScheduleSlot {
    return { kind: "specific_planned", courseId, title: courseId, credits: 4 } as unknown as ScheduleSlot;
}
function completedSlot(courseId: string): ScheduleSlot {
    return { kind: "completed", courseId, title: courseId, credits: 4, grade: "A" } as unknown as ScheduleSlot;
}

export function makeFixtureSchedule(): ForwardSchedule {
    return {
        studentId: "stu-eval",
        homeSchoolId: "cas",
        graduationTerm: "2028-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [
            {
                term: "2025-fall",
                locked: true,
                slots: [completedSlot("CSCI-UA 101")],
                plannedCredits: 4,
                notes: [],
                loadRationale: {} as never,
            },
            {
                term: "2027-spring",
                locked: false,
                slots: [plannedSlot("CSCI-UA 201")],
                plannedCredits: 4,
                notes: [],
                loadRationale: {} as never,
            },
            {
                term: "2027-fall",
                locked: false,
                slots: [plannedSlot("CSCI-UA 102")],
                plannedCredits: 4,
                notes: [],
                loadRationale: {} as never,
            },
        ],
    } as unknown as ForwardSchedule;
}

export const FIXTURE_SCHEDULE: ForwardSchedule = makeFixtureSchedule();

/** Plain-English summary of FIXTURE_SCHEDULE — fed to the real LLM in
 *  Part 2 so the model has the ground truth to describe naturally. */
export const FIXTURE_PLAN_SUMMARY = [
    "Forward degree plan (ground truth):",
    "- CSCI-UA 101 (Intro to Computer Science) — COMPLETED in Fall 2025 (grade A, locked/final, cannot move).",
    "- CSCI-UA 201 (Computer Systems Organization) — planned for Spring 2027 (movable).",
    "- CSCI-UA 102 (Data Structures) — planned for Fall 2027 (movable).",
    "- Graduation term: Spring 2028.",
].join("\n");

// ============================================================
// Part 1 — deterministic fixture table
// ============================================================

export interface PlanClaimFixture {
    id: string;
    reply: string;
    /** true → checkPlanClaims MUST emit an ungrounded_plan_claim. */
    expectBlock: boolean;
    note: string;
}

// ---- NEGATIVES (expectBlock: true) — ungrounded claims that MUST block.
// A claim that disagrees with FIXTURE_SCHEDULE (wrong term, wrong grad
// term, wrong lock status, both lock directions, a course the plan does
// not place). ≥6 required.
const NEGATIVES: PlanClaimFixture[] = [
    {
        id: "N-01-wrong-term",
        reply: "CSCI-UA 102 is in Spring 2026.",
        expectBlock: true,
        note: "wrong placement: plan puts 102 in Fall 2027, not Spring 2026",
    },
    {
        id: "N-02-wrong-season",
        reply: "CSCI-UA 102 is scheduled for Spring 2027.",
        expectBlock: true,
        note: "near-miss season: 102 is Fall 2027, not Spring 2027",
    },
    {
        id: "N-03-wrong-grad-term",
        reply: "Based on this plan, you graduate Fall 2027.",
        expectBlock: true,
        note: "wrong graduation term: stored grad is Spring 2028",
    },
    {
        id: "N-04-wrong-grad-year",
        reply: "Good news — you graduate Spring 2027 on this plan.",
        expectBlock: true,
        note: "wrong graduation year: stored grad is Spring 2028",
    },
    {
        id: "N-05-movable-claimed-locked",
        reply: "CSCI-UA 102 is locked and final — you can't change it now.",
        expectBlock: true,
        note: "wrong lock: 102 is a movable specific_planned slot, not locked",
    },
    {
        id: "N-06-locked-claimed-movable",
        reply: "You can still move CSCI-UA 101 to a later term if you'd like.",
        expectBlock: true,
        note: "inverse lock: 101 is completed/locked, cannot be moved",
    },
    {
        id: "N-07-unplaced-course",
        reply: "I've placed CSCI-UA 480 in Fall 2027 for you.",
        expectBlock: true,
        note: "course the plan does not place at all, asserted with a concrete term",
    },
    {
        id: "N-08-locked-set-in-stone",
        reply: "CSCI-UA 102 is set in stone for now.",
        expectBlock: true,
        note: "wrong lock (set in stone): 102 is movable",
    },
];

// ---- POSITIVES (expectBlock: false) — grounded / natural replies that
// MUST NOT block. CRUCIALLY includes the false-positive-risk phrasings
// the D5.1 reviews surfaced (prereq chain, "to graduate on time …",
// "your final course is …", two-course opposite-lock, NEGATED
// statements), plus a correct placement and a no-term-claim case. ≥8.
const POSITIVES: PlanClaimFixture[] = [
    {
        id: "P-01-correct-placement",
        reply: "CSCI-UA 102 is in Fall 2027.",
        expectBlock: false,
        note: "correct placement — must pass (normalizer Fall 2027 == 2027-fall)",
    },
    {
        id: "P-02-no-term-claim",
        reply: "CSCI-UA 102 is a great course and pairs well with your other classes.",
        expectBlock: false,
        note: "no term claim — nothing to ground, must not block",
    },
    {
        id: "P-03-prereq-chain",
        reply: "Since CSCI-UA 102 requires CSCI-UA 101 which you finished in Fall 2025, it's placed afterward.",
        expectBlock: false,
        note: "D5.1-FP: prereq-chain — 101's Fall 2025 must NOT bind to 102",
    },
    {
        id: "P-04-graduate-on-time",
        reply: "To graduate on time, take CSCI-UA 102 in Fall 2027.",
        expectBlock: false,
        note: "D5.1-FP: a placement term in a 'graduate' clause is a placement, not a grad claim",
    },
    {
        id: "P-05-final-course-noun",
        reply: "Your final course is CSCI-UA 102 in Fall 2027.",
        expectBlock: false,
        note: "D5.1-FP: bare-noun 'final course' is not a lock assertion; placement is correct",
    },
    {
        id: "P-06-two-course-opposite-lock",
        reply: "CSCI-UA 101 is final, and CSCI-UA 102 can still move.",
        expectBlock: false,
        note: "D5.1-FP: opposite-lock sentence — 101 locked (correct), 102 movable (correct)",
    },
    {
        id: "P-07-negated-lock",
        reply: "CSCI-UA 102 isn't locked yet, so you can still move it.",
        expectBlock: false,
        note: "D5.1-FP: NEGATED lock — disclaims, not asserts; 102 is movable (true)",
    },
    {
        id: "P-08-negated-grad",
        reply: "You won't graduate in Fall 2027 as you feared — your plan targets Spring 2028.",
        expectBlock: false,
        note: "D5.1-FP: NEGATED grad term — disclaims Fall 2027; the asserted Spring 2028 is correct",
    },
    {
        id: "P-09-grad-correct",
        reply: "With this plan you graduate Spring 2028.",
        expectBlock: false,
        note: "correct graduation term — must pass",
    },
    {
        id: "P-10-prior-sentence-grad",
        reply: "With this plan you graduate Spring 2028. CSCI-UA 102 is your last CS requirement.",
        expectBlock: false,
        note: "grad term from a prior sentence must not bleed onto 102 (no term claim on 102)",
    },
];

export const PLAN_CLAIM_EVAL_FIXTURES: PlanClaimFixture[] = [...NEGATIVES, ...POSITIVES];

// ============================================================
// Inline unconditional tests (run in CI, no API key).
// These ARE the operationalized exit-criterion gate.
// ============================================================

/** Run the full validator and return only the plan-claim violations. */
function planClaimBlocks(reply: string, schedule: ForwardSchedule): boolean {
    const verdict = validateResponse({
        assistantText: reply,
        invocations: [],
        forwardSchedule: schedule,
    });
    return verdict.violations.some((v) => v.kind === "ungrounded_plan_claim");
}

describe("planClaims eval — deterministic exit-criterion fixtures", () => {
    for (const f of PLAN_CLAIM_EVAL_FIXTURES) {
        it(`[${f.id}] ${f.expectBlock ? "BLOCKS" : "passes"} — ${f.note}`, () => {
            const blocked = planClaimBlocks(f.reply, FIXTURE_SCHEDULE);
            expect(
                blocked,
                `Fixture ${f.id} (${f.note}) — expected expectBlock=${f.expectBlock}, ` +
                    `got blocked=${blocked}. Reply: ${JSON.stringify(f.reply)}`,
            ).toBe(f.expectBlock);
        });
    }

    it("fixture-count invariant: ≥6 negatives (must block) AND ≥8 positives (must not block)", () => {
        const negatives = PLAN_CLAIM_EVAL_FIXTURES.filter((f) => f.expectBlock);
        const positives = PLAN_CLAIM_EVAL_FIXTURES.filter((f) => !f.expectBlock);
        expect(
            negatives.length,
            `need ≥6 negatives (ungrounded claims that MUST block); have ${negatives.length}`,
        ).toBeGreaterThanOrEqual(6);
        expect(
            positives.length,
            `need ≥8 positives (grounded replies that MUST NOT block); have ${positives.length}`,
        ).toBeGreaterThanOrEqual(8);
    });
});

// ============================================================
// Part 2 — ANTHROPIC_API_KEY-gated real-LLM false-positive safety net
// ============================================================
// Prompts the REAL model to describe the FIXTURE plan in natural
// adviser prose grounded in FIXTURE_PLAN_SUMMARY, then asserts the
// validator does NOT false-block the model's phrasing. Gated on
// ANTHROPIC_API_KEY so it never runs in CI (no key in that env).
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... npx tsx packages/engine/tests/agent/planClaims.eval.ts
//   ANTHROPIC_API_KEY=sk-... npx vitest run packages/engine/tests/agent/planClaims.eval.ts
// ============================================================

/** Grounded prompts. Each asks the model to describe a TRUE fact about
 *  the fixture plan; a correct, grounded reply must NOT trip a false
 *  block. The validator firing here ⇒ a false positive worth fixing. */
export const LLM_FALSE_POSITIVE_PROMPTS: Array<{ id: string; question: string }> = [
    {
        id: "L-01-term-and-grad",
        question:
            "In one paragraph, tell the student what term CSCI-UA 102 is in and when they graduate, based on this plan.",
    },
    {
        id: "L-02-prereq-chain",
        question:
            "In one or two sentences, explain why CSCI-UA 102 is placed when it is relative to its prerequisite CSCI-UA 101, based on this plan.",
    },
    {
        id: "L-03-lock-status",
        question:
            "In one or two sentences, tell the student which of CSCI-UA 101 and CSCI-UA 102 is locked/final and which can still move, based on this plan.",
    },
    {
        id: "L-04-on-time",
        question:
            "In one sentence, tell the student what to take in Fall 2027 to graduate on time, based on this plan.",
    },
];

export interface LlmFalsePositiveResult {
    id: string;
    question: string;
    reply: string;
    falseBlocked: boolean;
    violationDetails: string[];
}

export async function runLlmFalsePositiveNet(): Promise<LlmFalsePositiveResult[]> {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(
            "ANTHROPIC_API_KEY is not set. Set it to run the plan-claim real-LLM false-positive net.",
        );
    }

    // Lazy import the SDK only when running with the API key (mirror
    // preferenceExtraction.eval.ts) so the file compiles + the inline
    // tests run without the SDK being required at load time.
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const results: LlmFalsePositiveResult[] = [];
    for (const prompt of LLM_FALSE_POSITIVE_PROMPTS) {
        const response = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 512,
            system:
                "You are a professional NYU academic adviser. Answer ONLY from the plan below — " +
                "do not invent any term, graduation date, or lock status. Be natural and concise.",
            messages: [
                {
                    role: "user",
                    content: `${prompt.question}\n\n${FIXTURE_PLAN_SUMMARY}`,
                },
            ],
        });

        const reply = response.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join("\n");

        const verdict = validateResponse({
            assistantText: reply,
            invocations: [],
            forwardSchedule: FIXTURE_SCHEDULE,
        });
        const planViolations = verdict.violations.filter((v) => v.kind === "ungrounded_plan_claim");

        results.push({
            id: prompt.id,
            question: prompt.question,
            reply,
            falseBlocked: planViolations.length > 0,
            violationDetails: planViolations.map((v) => v.detail),
        });
    }
    return results;
}

// Operator-gated vitest block. Skips cleanly in CI (no API key).
describe("planClaims eval — real-LLM false-positive net (gated on ANTHROPIC_API_KEY)", () => {
    if (!process.env.ANTHROPIC_API_KEY) {
        it.skip("requires ANTHROPIC_API_KEY — grounded LLM replies must not false-block", () => {
            /* gated: no API key in this environment */
        });
        return;
    }

    it("grounded real-LLM replies describing the fixture plan must NOT false-block", async () => {
        const results = await runLlmFalsePositiveNet();
        const falsePositives = results.filter((r) => r.falseBlocked);
        for (const fp of falsePositives) {
            // Keep failures informative — log which prompt + reply false-blocked.
            console.error(
                `FALSE BLOCK [${fp.id}]\n  prompt: ${fp.question}\n  reply: ${fp.reply}\n  violations:\n    ${fp.violationDetails.join("\n    ")}`,
            );
        }
        expect(
            falsePositives.length,
            `${falsePositives.length} grounded LLM reply/replies were false-blocked (see logs above)`,
        ).toBe(0);
    }, 60_000);
});

// ============================================================
// Direct-invocation entry (tsx) — prints the false-positive net.
//   ANTHROPIC_API_KEY=sk-... npx tsx packages/engine/tests/agent/planClaims.eval.ts
// The package is ESM ("type":"module"), so require.main is never set;
// the ANTHROPIC_API_KEY gate is the run condition (same as
// preferenceExtraction.eval.ts).
// ============================================================
if (process.env.ANTHROPIC_API_KEY) {
    runLlmFalsePositiveNet()
        .then((results) => {
            console.log("\n=== Plan-claim real-LLM false-positive net (D5.3) ===\n");
            let falseBlocks = 0;
            for (const r of results) {
                const tag = r.falseBlocked ? "FALSE-BLOCK" : "ok";
                console.log(`[${r.id}] ${tag}`);
                if (r.falseBlocked) {
                    falseBlocks++;
                    console.log(`  reply: ${r.reply}`);
                    for (const d of r.violationDetails) console.log(`  violation: ${d}`);
                }
            }
            console.log(
                `\n${results.length - falseBlocks}/${results.length} grounded replies passed (no false block).`,
            );
            if (falseBlocks > 0) process.exit(1);
        })
        .catch((err) => {
            console.error("Plan-claim LLM net failed:", err);
            process.exit(1);
        });
}
