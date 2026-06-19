# `propose_whatif_assumption` — Tool Audit

> Last verified against code: 2026-06-19 (plan 35 — tool created; plan 37 — D-7 IP-membership guard + D-4 P/F-eligibility gate added to `validateInput`; `/api/plan/whatif` route now runs `validateInput` before `.call` so the editor path is covered).

Source files:
- Tool definition: `packages/engine/src/agent/tools/proposeWhatIfAssumption.ts`
- Shared re-solve machinery: `packages/engine/src/agent/forwardSchedule/whatIfAssumption.ts`
- DPR transforms: `packages/engine/src/agent/forwardSchedule/whatIfToDpr.ts` (`applyWithdrawalToDpr` / `applyPassFailToDpr`)
- P/F eligibility: `packages/engine/src/agent/forwardSchedule/pfEligibility.ts`
- Window check: `packages/engine/src/agent/forwardSchedule/ipChangeability.ts` (`classifyIpChangeability`)
- Web route: `apps/web/app/api/plan/whatif/route.ts`

---

## Purpose

**Branch B of the three-branch what-if taxonomy (CORE RULE 16):** when the student says "I withdrew" or "I'll take pass/fail for course X" (a current-term in-progress course), this tool treats the claim as an UNVERIFIED ASSUMPTION, builds a synthetic DPR in-memory via the matching pure transform, re-solves through the same frozen 8-axis pipeline the build path uses, and returns the PROPOSED (un-persisted) plan + a labeled `whatIfAssumption` marker (course/outcome + honest hedges + the registrar-window caveat). The student can then **Confirm** the resulting plan via the workspace Confirm rail.

This is the **propose half** of a propose→confirm round-trip — it is the actionable sibling of `probe_counterfactual` (which is pure read-only introspection). Both reuse the same `solveWhatIfAssumption` machinery (`whatIfAssumption.ts`).

**R1 guardrail (never-overwrite-DPR):** at propose time this tool NEVER writes session state. Only the CONFIRM step (via `/api/plan/whatif`) persists the resulting `forward_schedule`. The authoritative `students.parsed_dpr` is **never overwritten** by a hypothetical — `assertAuthoritativeDpr` + a byte-identity test enforce this. Confirming a PLAN is not recording a FACT (CORE RULE 15 §6).

```mermaid
flowchart TD
    Q[Student: I withdrew / I'll take P/F for X]
    VI{validateInput:<br/>D-7 IP-membership +<br/>D-4 P/F-eligibility}
    REJ[Reject — not in-progress / P/F not allowed]
    SYNTH[applyWithdrawalToDpr OR applyPassFailToDpr<br/>→ synthetic in-memory DPR]
    SOLVE[Re-solve through 8-axis pipeline]
    MARK[Build whatIfAssumption marker:<br/>label + hedges + windowCaveat]
    OUT[Return proposed plan + marker]
    CONF[Student clicks Confirm on canvas]
    PERSIST[/api/plan/whatif persists ONLY forward_schedule<br/>never the DPR]
    Q --> VI
    VI -- rejected --> REJ
    VI -- ok --> SYNTH
    SYNTH --> SOLVE
    SOLVE --> MARK
    MARK --> OUT
    OUT --> CONF
    CONF --> PERSIST
```

---

## 1. Input schema

```
{
  courseId: string               // The current-term (in-progress) course
  outcome: "withdraw" | "pass" | "fail"
  now?: string (ISO 8601)        // Override today's date (test-only; defaults to real clock)
}
```

- `outcome "withdraw"` → a "W" (GPA-neutral; the requirement re-opens universally).
- `outcome "pass"` → a Pass election (keeps credit; may only satisfy electives — school-specific, hedged).
- `outcome "fail"` → a Fail election (re-opens the requirement AND lowers GPA — not GPA-neutral).

---

## 2. `validateInput` — three guards (run in order)

`validateInput` runs before `call()`. All three guards must pass:

### Guard 1 — forward plan exists
`session.forwardSchedule` or `session.studentDraftPlan` must be set. Rejection: "No forward plan exists in this session. Call plan_forward_degree first, then propose a what-if assumption."

### Guard 2 — DPR loaded
`session.degreeProgressReport` must be set. Rejection: "No Degree Progress Report loaded. Cannot propose a what-if assumption without DPR data."

### Guard 3 — D-4 P/F-eligibility (plan 37)
If `outcome` is `"pass"` or `"fail"` AND `session.schoolConfig?.passFail?.canElect === false` (e.g. Tandon Engineering), the call is rejected before the tool runs:

> "[School name] doesn't allow students to elect the pass/fail option — only courses that are already graded pass/fail count toward your record. If you have questions about your grading options, verify with your adviser."

`"withdraw"` is **universal** — it is never blocked by this guard.

### Guard 4 — D-7 IP-membership (plan 37)
The `courseId` is canonicalized and looked up in `session.degreeProgressReport.courseHistory`. Two rejection cases:

- **Not found at all** (likely a planned course, not a DPR row): "X isn't a course you're currently taking — it looks planned, not in progress. To remove a planned course, drop it instead."
- **Found but `row.type !== "IP"`** (completed / graded): "Withdraw and pass/fail apply only to a course you're currently taking (in progress). X is already completed."

---

## 3. The what-if solves (via `solveWhatIfAssumption`)

`call()` delegates to `solveWhatIfAssumption(session, currentPlan, { courseId, outcome, now? })` in `whatIfAssumption.ts`. This helper:

1. **Applies the pure DPR transform** (never mutates `session.degreeProgressReport`):
   - `"withdraw"` → `applyWithdrawalToDpr(dpr, courseId)` — removes the course from every requirement leaf's `coursesUsed[]` that it exclusively satisfied and re-opens those leaves; marks the course grade as `"W"`.
   - `"pass"` → `applyPassFailToDpr(dpr, courseId, pfEligibility)` — marks the row `passFailElected: true` and increments `passFailUsedUnits`; clears the course from non-eligible requirement leaves (where a P/F grade can't satisfy the letter-grade requirement).
   - `"fail"` → `applyPassFailToDpr(dpr, courseId, pfEligibility)` — same as `"pass"` but also flips the grade to `"F"`, causing it to re-open the requirement leaf AND lower GPA (a P/F fail is not GPA-neutral).

2. **Checks the registrar window** (`classifyIpChangeability`) — surfaces the F3 window caveat (add/drop, withdrawal-only, windows-closed, or hedged) into `result.windowCaveat`.

3. **Re-solves through the frozen pipeline** — `buildSolverInputWithRulesFromSession(session, syntheticDpr, prefs)` + `solveForwardSchedule(solverInput)` + `finalizeForwardSchedule(...)` — the same 8-axis pipeline used by `plan_forward_degree`. The synthetic DPR is passed throughout; `session.degreeProgressReport` is never written.

4. **Builds hedges** — school-specific P/F consequences (Stern counts toward major; most schools electives-only; unknown → hedge). Universal: "verify with your adviser; nothing is official until it shows on your next DPR."

5. **Returns** `{ feasible, diff, consequences, conflicts?, schedule, planDiff, state, hedges, windowCaveat? }`.

---

## 4. `passFailElected` + the 8th validator axis

A `"pass"` election via `applyPassFailToDpr` increments `dpr.cumulative.passFailUsedUnits` and flags the course row `passFailElected: true`. The `pfEligibility` helper (reading `session.schoolConfig.passFail`) determines:

- Whether P/F is allowed at all (`canElect`).
- Whether the specific course/slot counts toward a major at this school (Stern: yes; most: electives-only).
- Per-term and career limits.

These flags feed the 8th `passFailLimitsRespected` axis in `runGraduationPathValidator`, so a what-if that would exceed P/F limits surfaces as an infeasible plan (red card) rather than silently proceeding.

---

## 5. Output

```
{
  feasible: boolean,                    // 8-axis validator verdict
  diff: { added, removed },             // vs the CURRENT plan
  consequences: string[],
  conflicts?: Array<{ kind, detail }>,  // from the validator's infeasibilityReport
  proposedSchedule?: ForwardSchedule,   // pure preview — never persisted at propose time
  planDiff?: PlanDiff,                  // rich delta (workload/balance/trade-offs)
  state: PlanState,                     // validator-derived state of proposed plan
  whatIfAssumption: {                   // G3.1 marker
    courseId: string,
    outcome: "withdraw" | "pass" | "fail",
    label: string,                      // e.g. "Assumes you withdraw from CSCI-UA 102 …"
    hedges: string[],                   // school-specific P/F hedges + verify-with-adviser
    windowCaveat?: string               // F3 registrar-window actionability caveat
  },
  windowCaveat?: string                 // echoes whatIfAssumption.windowCaveat
}
```

`proposedSchedule` is a **pure preview** — it is what would be stored if the student confirmed. It is NOT routed through any persistence path at propose time.

### Valid vs. invalid result

- **Feasible** (`feasible: true`) → the workspace shows a labeled proposed scenario tab (CONFIRMABLE via the Confirm button).
- **Infeasible** (`feasible: false`) → the workspace shows a red explanation card (the validator's failing axes + detail) in **chat only** — no scenario tab, not confirmable (I4, plan 37).

---

## 6. Confirm path — `/api/plan/whatif`

The student confirms the proposed what-if by clicking the workspace Confirm button, which calls `POST /api/plan/whatif` (`apps/web/app/api/plan/whatif/route.ts`). The route:

1. **Runs `proposeWhatIfAssumptionTool.validateInput` before `.call`** (plan 37 follow-up fix — the editor path previously bypassed validation; now D-7 and D-4 are enforced on every code path).
2. Calls `runConfirmWhatIfAssumption(session, ...)` which re-solves with the synthetic DPR and writes the resulting `forward_schedule` to the DB via `scheduleStore.persistSchedule(...)`.
3. **Never writes `students.parsed_dpr`** — the `assertAuthoritativeDpr` guard + a byte-identity test between the original and post-confirm DPR enforce the R1 invariant. Only `forward_schedule` is persisted.
4. **Gated on feasibility** — consistent with `confirm_plan_change` (M1, plan 37): an infeasible result is never committed.

---

## 7. Tool metadata

| Property | Value |
|---|---|
| `name` | `"propose_whatif_assumption"` |
| `isReadOnly` | `true` (the propose step never writes session state) |
| `maxResultChars` | `4000` |
| `outputMode` | `"synthesis"` (default — no `extractVerbatim`) |

`summarizeResult` emits:

```
PROPOSE WHAT-IF ASSUMPTION (<outcome>) — <VALID | INFEASIBLE>
Assumption: <label>
Conflicts (<n>): [<kind>] <detail>  (if any)
Added slots: <n>, removed slots: <m>
Consequences:
  • <consequence>
  • ...
Registrar-window caveat: <caveat>   (if present)
Hedges:
  • <hedge>
  • ...
```

---

## 8. Relationship to sibling tools

| Tool | Relationship |
|---|---|
| `probe_counterfactual` | Read-only introspection companion ("what happens if…"). Uses the **same `solveWhatIfAssumption` machinery** but has NO confirm path — it is prose-only, produces no workspace scenario tab. Use `probe_counterfactual` for exploration; use `propose_whatif_assumption` when the student wants to ACT on the assumption. |
| `confirm_plan_change` | The general-purpose confirm tool for `propose_plan_change` mutations. **Not used** for what-if-assumption confirms — those go through `/api/plan/whatif`. |
| `what_if_audit` | Branch C (open hypothetical estimates). `propose_whatif_assumption` is Branch B (current-term grade-outcome assumptions). CORE RULE 16 routes between all three branches. |
| `plan_forward_degree` | Hard prerequisite — `validateInput` rejects if neither `session.forwardSchedule` nor `session.studentDraftPlan` is set. |

---

## 9. Known limitations

- **Exact GPA of a hypothetical fail is deferred.** `applyPassFailToDpr` marks the grade as `"F"` and re-opens the requirement leaf, but the engine does not recompute the exact new cumulative GPA (the GPA consequence is left to the hedge text). Planned for a future pass.
- **Per-term P/F limit not yet enforced.** The 8th axis checks the career cap; per-term limits (Stern/Gallatin allow only 1 P/F per semester) are captured in the school config but the per-term constraint is not yet threaded into the validator. Flagged for a future fix.
- **Window caveat absent when term can't be located.** `classifyIpChangeability` needs a term string derived from the course's DPR row; if that term can't be matched against the academic calendar, `windowCaveat` is absent (hedged).
