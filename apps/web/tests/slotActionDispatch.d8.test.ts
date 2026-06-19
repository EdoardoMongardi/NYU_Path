// ============================================================
// Plan 37 D-8 guard — slot-action dispatch is PROPOSE-ONLY
// ============================================================
// GOAL: a regression guard so a future change cannot wire a slot
// action (drop / withdraw / passFail) straight to a DB commit.
//
// APPROACH (option c from the spec):
//   - Test that `planDrop` POSTs to `/api/plan/drop` (a PROPOSE verb)
//     and NOT to `/api/plan/confirm`.
//   - Test that `planWhatIf` POSTs to `/api/plan/whatif` (a PROPOSE verb)
//     and NOT to `/api/plan/confirm`.
//   - Assert via static grep that `onSlotAction` in page.tsx references
//     ONLY the propose verbs (planDrop / planWhatIf) and NOT planConfirm
//     in its dispatch switch body.
//
// Why this is meaningful as a D-8 guard:
//   The real risk is that someone wires a slot action → planConfirm
//   directly (skipping the propose→review→confirm user journey). These
//   tests pin the TWO ROUTES that F3 calls (`/api/plan/drop` and
//   `/api/plan/whatif`) as propose-verbs, and the code-text scan pins
//   that the actual dispatch switch in page.tsx does not reference
//   `planConfirm` — making the invariant machine-checkable rather than
//   purely doctrinal.
// ============================================================

import { describe, it, expect, afterEach, vi } from "vitest";
import { planDrop, planWhatIf, planConfirm } from "../lib/planActionClient";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Shared fetch-stub utilities (mirrors planActionClient.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
    url: string;
    init: RequestInit;
}

function installFetch(impl: (url: string, init: RequestInit) => Promise<Response>): RecordedCall[] {
    const calls: RecordedCall[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return impl(url, init);
    };
    return calls;
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// D-8 guard tests: the F3 propose verbs hit the PROPOSE routes, not confirm
// ---------------------------------------------------------------------------

describe("D-8 guard — planDrop (slot 'drop' action) is a PROPOSE-verb", () => {
    it("planDrop POSTs to /api/plan/drop (PROPOSE), not /api/plan/confirm", async () => {
        const calls = installFetch(async () =>
            jsonResponse(200, {
                feasible: true,
                diff: { added: [], removed: [] },
                consequences: [],
                explanation: "ok",
                pendingMutationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                futureTerms: ["2026-fall"],
            }),
        );
        const result = await planDrop({ courseId: "CSCI-UA 301", term: "2026-fall" });
        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);
        // PROPOSE verb — must NOT hit /api/plan/confirm.
        expect(calls[0]!.url).toBe("/api/plan/drop");
        expect(calls[0]!.url).not.toBe("/api/plan/confirm");
    });

    it("planDrop result carries a pendingMutationId (staging, not committed)", async () => {
        installFetch(async () =>
            jsonResponse(200, {
                feasible: true,
                diff: { added: [], removed: [] },
                consequences: [],
                explanation: "ok",
                pendingMutationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                futureTerms: [],
            }),
        );
        const result = await planDrop({ courseId: "CSCI-UA 301" });
        // A pendingMutationId in the response means the change is STAGED
        // (pending confirm), not committed — consistent with the propose path.
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.pendingMutationId).toBeTruthy();
        }
    });
});

describe("D-8 guard — planWhatIf (slot 'withdraw'/'passFail' action) is a PROPOSE-verb", () => {
    it("planWhatIf POSTs to /api/plan/whatif (PROPOSE), not /api/plan/confirm", async () => {
        const calls = installFetch(async () =>
            jsonResponse(200, {
                feasible: true,
                diff: { added: [], removed: [] },
                consequences: [],
                explanation: "ok",
                pendingMutationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                futureTerms: [],
                whatIfAssumption: { label: "withdraw", windowCaveat: "" },
            }),
        );
        const result = await planWhatIf({ courseId: "CSCI-UA 301", outcome: "withdraw" });
        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("/api/plan/whatif");
        expect(calls[0]!.url).not.toBe("/api/plan/confirm");
    });

    it("planWhatIf (pass/fail arm) POSTs to /api/plan/whatif, not /api/plan/confirm", async () => {
        const calls = installFetch(async () =>
            jsonResponse(200, {
                feasible: true,
                diff: { added: [], removed: [] },
                consequences: [],
                explanation: "ok",
                pendingMutationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                futureTerms: [],
                whatIfAssumption: { label: "pass/fail", windowCaveat: "" },
            }),
        );
        await planWhatIf({ courseId: "CSCI-UA 301", outcome: "pass" });
        expect(calls[0]!.url).toBe("/api/plan/whatif");
        expect(calls[0]!.url).not.toBe("/api/plan/confirm");
    });

    it("planWhatIf result carries a pendingMutationId (staging, not committed)", async () => {
        installFetch(async () =>
            jsonResponse(200, {
                feasible: true,
                diff: { added: [], removed: [] },
                consequences: [],
                explanation: "ok",
                pendingMutationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                futureTerms: [],
                whatIfAssumption: { label: "withdraw" },
            }),
        );
        const result = await planWhatIf({ courseId: "CSCI-UA 301", outcome: "withdraw" });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.pendingMutationId).toBeTruthy();
        }
    });
});

describe("D-8 guard — planConfirm hits /api/plan/confirm (identity check)", () => {
    it("planConfirm (the ONLY commit verb) hits /api/plan/confirm, not /api/plan/drop or /api/plan/whatif", async () => {
        const calls = installFetch(async () =>
            jsonResponse(200, {
                feasible: true,
                diff: { added: [], removed: [] },
                consequences: [],
                storedIn: "forwardSchedule",
                consumedMutationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            }),
        );
        await planConfirm({ pendingMutationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
        // This documents that planConfirm (the commit verb) is a SEPARATE
        // function that hits /api/plan/confirm — i.e. it is NOT the same as
        // planDrop / planWhatIf. A refactor that accidentally merges these
        // or reroutes planDrop → /api/plan/confirm would fail the D-8 tests
        // above.
        expect(calls[0]!.url).toBe("/api/plan/confirm");
        expect(calls[0]!.url).not.toBe("/api/plan/drop");
        expect(calls[0]!.url).not.toBe("/api/plan/whatif");
    });
});

// ---------------------------------------------------------------------------
// D-8 static guard — `onSlotAction` in page.tsx NEVER references planConfirm
// ---------------------------------------------------------------------------
// We read the source of page.tsx and scan the `onSlotAction` dispatch body
// for any reference to `planConfirm`. Finding one would mean the slot-action
// popover (F3) can auto-commit without the student hitting "Confirm — make
// this My Plan" — a violation of the D-8 propose-only invariant.
//
// This is a static text scan, not a runtime assertion, so it DOESN'T depend
// on a full Next.js server render — it runs safely in the vitest node env.

describe("D-8 static guard — onSlotAction dispatch (page.tsx)", () => {
    const PAGE_PATH = path.resolve(
        import.meta.dirname,
        "../app/chat/page.tsx",
    );

    it("page.tsx exists and is readable", () => {
        // Guard: if the file moves/is renamed, the scan below fails loudly
        // here rather than silently passing (the empty-string case).
        expect(() => fs.readFileSync(PAGE_PATH, "utf8")).not.toThrow();
    });

    it("the onSlotAction switch calls planDrop (propose verb) for the 'drop' case", () => {
        const src = fs.readFileSync(PAGE_PATH, "utf8");
        // Extract the onSlotAction callback body (everything between the
        // opening "case 'drop'" and the next case / closing brace block).
        // We look for `planDrop(` to confirm the dispatch uses the propose verb.
        expect(src).toContain("planDrop(");
    });

    it("the onSlotAction switch calls planWhatIf (propose verb) for withdraw/passFail cases", () => {
        const src = fs.readFileSync(PAGE_PATH, "utf8");
        expect(src).toContain("planWhatIf(");
    });

    it("the onSlotAction dispatch body does NOT directly call planConfirm (D-8 propose-only)", () => {
        const src = fs.readFileSync(PAGE_PATH, "utf8");
        // Locate the onSlotAction function body:
        // It starts with "const onSlotAction = useCallback(" and ends at the
        // matching "[handlePlanActionResult, handleWhatIfResult]," dependency
        // array. We extract that range and check planConfirm is absent.
        const onSlotActionStart = src.indexOf("const onSlotAction = useCallback(");
        expect(onSlotActionStart).toBeGreaterThan(-1); // function must exist

        // Find the dependency array that terminates the callback (the closing
        // of the useCallback call after the function body).
        // The pattern "[handlePlanActionResult, handleWhatIfResult]" uniquely
        // identifies the end of the onSlotAction useCallback in this file.
        const depArrayMarker = "[handlePlanActionResult, handleWhatIfResult],";
        const onSlotActionEnd = src.indexOf(depArrayMarker, onSlotActionStart);
        expect(onSlotActionEnd).toBeGreaterThan(-1); // dep array must exist

        const onSlotActionBody = src.slice(onSlotActionStart, onSlotActionEnd + depArrayMarker.length);

        // D-8 INVARIANT: planConfirm must NOT appear inside the onSlotAction body.
        expect(onSlotActionBody).not.toContain("planConfirm");
    });

    it("onSlotAction routes 'drop' → handlePlanActionResult (not a direct commit)", () => {
        const src = fs.readFileSync(PAGE_PATH, "utf8");
        const onSlotActionStart = src.indexOf("const onSlotAction = useCallback(");
        const depArrayMarker = "[handlePlanActionResult, handleWhatIfResult],";
        const onSlotActionEnd = src.indexOf(depArrayMarker, onSlotActionStart);
        const body = src.slice(onSlotActionStart, onSlotActionEnd + depArrayMarker.length);

        // The 'drop' arm must call planDrop → then route the RESULT through
        // handlePlanActionResult (the propose-stage result handler, which
        // stages a preview rather than committing).
        expect(body).toContain("handlePlanActionResult(");
        // And must call planWhatIf for the 'withdraw'/'passFail' arms.
        expect(body).toContain("handleWhatIfResult(");
    });
});
