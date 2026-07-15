# NYU Path — glossary

One line per in-house term, with a pointer to its canonical doc. When a term here
and the code disagree, the code wins (`CLAUDE.md` → "working code is the source of truth").

| Term | Meaning | Canonical source |
|---|---|---|
| **DPR** | Degree Progress Report — the student's official Albert audit; the authoritative (tier-1) source of home school, declared major/minor, catalog year, courses, and grades. | [`core_philosophy.md`](core_philosophy.md); `current-system/engine/dpr.md` |
| **DPR-first** | Personalized answers are computed from the parsed DPR, never from free LLM generation. No DPR → the personalized tools hard-refuse. | [`core_philosophy.md`](core_philosophy.md) |
| **Tier 1 / Tier 2** | Tier 1 = authoritative DPR-derived facts. Tier 2 = bulletin RAG — cited, hedged policy text ("per the bulletin"), never presented as a personalized computation. | `current-system/engine/rag.md` |
| **Valid vs preferred** | A plan is *valid* if it passes all 8 validator axes; among valid plans the *preferred* one best fits the student's stated/​default preferences. Deterministic on validity, then preferred. | [`core_philosophy.md`](core_philosophy.md) |
| **The 8 axes** | The exact definition of "valid": `requirementGroupsSatisfied`, `poolSlotsResolvable`, `totalCreditsMeetMinimum`, `thresholdsMet`, `visaAxesPass`, `assumptionsExplicit`, `graduationTargetMet`, `passFailLimitsRespected`. `feasible === (no axis fails)`. | [`FROZEN.md`](FROZEN.md) §2; guard `frozenContractManifest.test.ts` |
| **Frozen engine contract / seam** | Every schedule-producing path must build + validate through the one seam (`buildSolverInput → solveForwardSchedule → finalizeForwardSchedule` + the 8-axis validator); never forked or bypassed. | [`FROZEN.md`](FROZEN.md) §1/§3 |
| **R1 guardrail** | The authoritative `students.parsed_dpr` is never overwritten by a hypothetical/synthetic DPR; a what-if confirm persists only the `forward_schedule`. | [`FROZEN.md`](FROZEN.md) §5/§6 |
| **Feasibility-first search** | The planner finds the *first* complete plan satisfying every constraint (backtracking + forward-checking), then local-improves it — not a greedy fill, and not a proven global optimum. | `current-system/engine/forward-schedule.md` |
| **Pool slot** | A requirement satisfiable by any course from a defined pool (e.g. a major-elective slot). "Resolvable" = a concrete course can fill it. | `current-system/tools/bind_pool_slot.md` |
| **Materialize** | Turn a structural plan (course-level) into a real schedule with sections (CRN, time, instructor) for the near term. | `current-system/engine/section-materialization.md` |
| **FOSE** | NYU's public class-search API. The plan-38 section-scheduling feature built on it was **deactivated 2026-07-14** (no acceptable live-seat-data source). Distinct from `materialize_sections`, which stays live. | [`STATUS.md`](STATUS.md) |
| **What-if branches A / B / C** | A = program change (upload an Albert What-If audit); B = current-term withdraw/pass-fail (DPR transform, confirmable); C = a confidence-disclaimed estimate. The authoritative DPR is never overwritten in any branch. | [`core_philosophy.md`](core_philosophy.md); Plan 35 |
| **W / P/F** | Withdrawal (a "W" — re-opens the requirement, GPA-neutral) and Pass/Fail. A W is universal; P/F is school-specific (satisfies a major only where the school allows it, e.g. Stern). | [`core_philosophy.md`](core_philosophy.md) (IP-window paragraph) |
| **IP course** | An in-progress course. Future-term IP = freely changeable (only planning); current-term IP = window-aware (drop/withdraw/pass-fail deadlines, hedged with a confidence rail); final-grade = unmodifiable. | [`core_philosophy.md`](core_philosophy.md) |
| **CORE RULES (12–16)** | Numbered advisor rules enforced in the engine's system prompt + response validator (e.g. RULE 14 read-only DPR fields, RULE 15 IP-window, RULE 16 three-branch what-if). Referenced in [`STATUS.md`](STATUS.md). | `packages/engine/src/agent/systemPrompt.ts` |
| **Confidence rail** | The "confidence level + verify with your adviser" disclaimer attached to any conclusion that is not ~99% grounded/computed. | [`core_philosophy.md`](core_philosophy.md) |
