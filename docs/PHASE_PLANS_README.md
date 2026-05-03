# Phase Plans 12.7–15 — Execution Index

This index ties together the five planning documents that take NYU Path
from its current state (Phase 12.5 in production) through to a full
multi-semester forward planner with live FOSE section materialization.
Each plan is self-contained; this document is the orchestrator.

## Execution order (linear; do not skip)

1. **`PHASE_12_7_PLAN.md`** — Bulletin scrape extension to all 8 undergrad schools. Pure data; ~½–1 day. **No engine impact.** Output: `data/bulletin-raw/courses/<DEPT>_<SCHOOL>/<NUMBER>/index.md` for ~5,000–7,000 courses.
2. **`PHASE_12_8_PLAN.md`** — Bulletin parsing → structured `prereqs.json` + `courses-offerings.json`. Depends on 12.7. ~2 days. Validation gate: must match the 27 hand-curated entries already in `packages/engine/src/data/prereqs.json`.
3. **`PHASE_12_9_PLAN.md`** — Bulletin embeddings: rich course descriptions for `search_courses` (B) + non-CAS curriculum chunks for `search_policy` (C). Optional but recommended; can run in parallel with Phase 13. ~1 day.
4. **`PHASE_13_PLAN.md`** — Multi-semester forward planner with constraint solver + schedule sidebar UI + 3 reasoning-trace fixes. Depends on 12.8. ~5–6 days.
5. **`PHASE_14_PLAN.md`** — Preferences + overrides (load styles, pins, exclusions, summer/J-term opt-in, alternatives, co-req enforcement) + LLM-extraction system prompt. Depends on 13. ~5–7 days.
6. **`PHASE_15_PLAN.md`** — Live FOSE section materialization, time-conflict detection, conflict-free combination enumeration, instructor surfacing. Depends on 13 (composes cleanly with 14). ~3–4 days.

**Phase 16 (RateMyProfessor / instructor-rating overlay) is explicitly DROPPED.** Reasons documented in `PHASE_15_PLAN.md`. Instructor names are surfaced verbatim per section so the student picks based on their own preferences — no rating overlay.

## How to execute

Each plan declares its required sub-skill:
> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans

In a fresh session:

```
Working in /Users/edoardomongardi/Desktop/Ideas/NYU Path on branch
phase-10-architecture-and-followups. Read PHASE_<N>_PLAN.md in full.
Execute via superpowers:subagent-driven-development — fresh subagent
per task, two-stage review (spec then code-quality) after each.
```

The subagent-driven-development skill dispatches fresh subagents that read the plan directly, so cross-conversation context is not needed.

## Pre-flight verification (do this BEFORE any code change in any phase)

Before the first code-edit task in each phase, the executor MUST verify the repo's current shape matches the plan's assumptions. The plans assert specific field names that an investigation confirmed earlier. Repo state can drift; assertions can become stale. Verify:

| Assertion | Verify by |
|---|---|
| `packages/engine/src/data/prereqs.json` contains 27 hand-curated entries | `wc -l packages/engine/src/data/prereqs.json && jq 'length' packages/engine/src/data/prereqs.json` |
| `packages/engine/src/dpr/schema.ts` field names: `courseHistory`, `requirementGroups`, `creditsEarned` | Read the file end-to-end |
| `SchoolConfig` field name for graduation minimum (`graduationCreditMinimum` / `graduationMinimumCredits` / etc.) | `grep -n "graduation\|credit" packages/shared/src/types.ts` |
| `ToolInvocation` field shape for `summary` and `result` | Read `packages/engine/src/agent/agentLoop.ts` |
| Existing `searchAvailability` tool path (the registered one vs. the dead duplicate) | `grep -rn "searchAvailability" packages/engine/src/agent/registry.ts` |
| `LLMStreamEvent` union variants (post Phase 12.5: includes `thinking_delta`) | `grep -n "type:.*delta" packages/engine/src/agent/llmClient.ts` |
| `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` env vars live in `.env.local` | `cat .env.local 2>/dev/null \| grep -E "OPENAI\|ANTHROPIC"` |
| Existing course-catalog embedding index path | `ls data/course-catalog/` |
| Existing policy chunks file path | `ls data/policy-corpus/` |
| Bulletin layout: per-dept `_index.md` (NOT per-course subdirs); names are lowercase + underscore + may contain digits | `find data/bulletin-raw/courses -maxdepth 2 -name "_index.md" \| head -5` and confirm output shows `<dept>_<suffix>/_index.md` paths, not `<DEPT>_<SUFFIX>/<NUM>/index.md` |

If any assertion is wrong, **adapt the plan's code to match the actual repo** rather than forcing the repo to match the plan. The plans were drafted from earlier investigations; ground truth is the current repo state.

## All 21 locked design decisions (canonical list)

Recorded across the plans. Restated here so a fresh executor sees them in one place.

### Phase 13 (decisions 1–8 + 21)

1. **NOT operator** in prereq trees: strictly enforced. Solver filters out a dependent course when any course in `notCourses` is in `coursesTaken`.
2. **AP/IB equivalency:** modeled as synthetic course IDs (`AP-CS-A-3`, `IB-MATH-HL-5`). Treated as normal courseIds; the DPR ingest path injects synthetic IDs when an AP-credit row is present.
3. **Instructor permission ("or instructor permission" / "or department approval"):** middle path. Solver places the course (soft-allow), but the slot carries `requiresPetition: true` annotation that the sidebar renders as a yellow flag.
4. **Minimum-grade thresholds** (e.g. "Minimum Grade of C" on a prereq): trust DPR. Solver treats course-in-coursesTaken as satisfied; doesn't verify grade against threshold.
5. **Cross-school courses:** lenient. With full undergrad bulletin coverage from Phase 12.7+12.8, almost all CAS prereqs reference courses we have data for. Edge cases gracefully degrade to "satisfied if in coursesTaken, else assume satisfied" — no annotation needed.
6. **Co-requisites:** Phase 13 ignores the `coreqs` field. Phase 14 implements same-term enforcement.
7. **Same-course retake:** trust DPR. If the course appears in both `coursesTaken` and `unmetRequirements`, the solver places it normally; downstream prereqs naturally chain.
8. **Optional electives above floor:** distinct rendering. Free-elective placeholders BELOW the credit floor (or when degree-credit minimum NOT met) render solid + "required." Above floor when degree minimum IS met → `optional: true`, dotted border + "optional" tag.

21. **Study-abroad courses (9000-series CAS) default-skip in solver, FOSE materializes site at runtime.** Bulletin location data is unreliable (~3% of chunks mention a study-abroad city, mostly as descriptive content like "Languages of Paris" rather than as a location qualifier; year-to-year drift makes static extraction stale). The structural signal is the courseId number range — NYU CAS uses 9000-series for site offerings (`ANTH-UA 9070`, `EXPOS-UA 9070`). Phase 13's solver default-skips any courseId matching `^[A-Z]+-UA 9\d{3}` unless the student has explicitly opted into a study-abroad term (Phase 14 preference, same shape as the summer/J-term opt-in). When a structural-plan course materializes through Phase 15's FOSE call, the section's `location` field tells the UI which site it actually runs at; the student picks the section accordingly. This split — bulletin for structure, FOSE for runtime — mirrors the prereqs-vs-availability split.

### Phase 14 (decisions 9–15)

9. **Load styles:** 5 modes — `balanced` (default, slack-based), `frontload` (place hard reqs early), `backload` (defer hard reqs), `light` (per-term override; pulls credit target down to floor), `heavy` (per-term override; pushes up to ceiling). `part-time-domestic` requires explicit `allowBelowF1Floor: true`.
10. **Pinning:** two-step (`propose_plan_change` → `confirm_plan_change`). Hard constraint in solver. Infeasible pins return conflict + a no-pin fallback plan.
11. **Exclusions:** same shape as pins, inverse polarity. CourseId is filtered out of candidates for the given term (or globally).
12. **Summer / J-term:** off by default. When standard schedule infeasible, `simulate_alternatives` proposes adding them. When student opts in, they enter the available-term enumeration.
13. **Confirmation = highest authority.** Student-confirmed plan is written to `session.forwardSchedule` even when it deviates from solver-optimal. Agent surfaces consequences but doesn't override.
14. **Co-requisite enforcement:** same-term constraint in solver. Phase 14 also adds the parser extension to populate the previously-empty `coreqs` field.
15. **Failed-course retake:** if DPR shows a failed grade (F or W), the course appears in `unmetRequirements`. Solver places it normally; if a downstream course depends on it, prereq check forces the failed course earlier in the schedule.

### Phase 15 (decisions 16–20)

16. **Per-call FOSE data-availability gate:** each `materialize_sections` invocation classifies the FOSE response as `full` / `partial` / `unavailable`. NOT a static window assumption; we don't assume "registration opens April 20." Each call inspects live response shape.
17. **Instructor names always surfaced:** FOSE returns `instr` (string) per section. Threaded verbatim to the UI. Student picks a section based on (open status + meeting time + instructor name). No instructor-rating overlay.
18. **Time-conflict detection:** two sections conflict if any of their `MeetingPattern`s overlap on the same day. Conflict-free combinations enumerated combinatorially, capped at 50.
19. **Course-swap on FOSE-unavailable:** if a structural-plan course has zero open sections in the target term, the materializer asks the structural solver for a legal alternative; original course defers to a later term. Structural plan persists; only immediate-term placement adjusts.
20. **FOSE TTL cache:** 5-minute in-memory cache per `(termCode, keyword)` query. No persistence.

## What's deferred / out of scope

- **RateMyProfessor / instructor-rating overlay (Phase 16):** SKIPPED. ToS violation risk + poor data density at NYU + 2-year-stale wrappers. Instructor name strings ARE surfaced; rating data is not.
- **NYU CourseEvalPro / Albert internal evaluations:** out of scope. NetID-gated, NYU-policy risk on top of RMP-style ToS risk.
- **Time-of-day preferences ("no Friday classes"):** Phase 16+ if needed.
- **Drag-to-reorder slots in sidebar:** Phase 16+.
- **Server-side persistence of `ForwardSchedule` to Postgres:** in-memory only through Phase 15. Phase 16+ if needed.
- **Honors thesis 2-term blocks:** Phase 16+.
- **Study-abroad term modeling:** Phase 16+.
- **CPT / internship credit adjustments:** Phase 16+.
- **Major change mid-stream:** already handled by `update_profile` two-step path; no new work.

## Risk areas worth eyes-on

- **Phase 12.8's LLM-parser regression validation:** must produce IDENTICAL JSON to the 27 curated entries. If parser fails on any of them, iterate on prompt before scaling.
- **Phase 13's solver greedy nature:** Phase 13 ships greedy + slack-based; Phase 15+ may need backtracking for complex prereq chains. Greedy outputs feasibility report so unsolved cases surface explicitly.
- **Phase 14's natural-language preference extraction:** 85% accuracy bar via the eval suite. Lower → iterate on system prompt.
- **Phase 15's FOSE response shape:** `hours` field format is unknown until Task 0 records real fixtures. Don't design parser blind.

## When something goes wrong mid-execution

- **Subagent reports `BLOCKED` or `NEEDS_CONTEXT`:** Read its report. If the blocker is a repo-state assumption mismatch (file not found, type field name wrong), update the plan's code to match the real repo and re-dispatch. If the blocker is an architectural ambiguity, escalate to the human operator.
- **Spec-compliance review fails:** the implementer subagent fixes within the same task; re-run the spec reviewer. Don't proceed to the code-quality reviewer until spec is ✅.
- **Code-quality reviewer flags Critical or Important issues:** the implementer subagent fixes; re-review. Don't mark the task complete until all Critical + Important issues are resolved.
- **Manual browser verification reveals a bug:** dispatch a fix subagent for the specific gap; do NOT proceed to the next phase.

## Push policy

Each phase ends with a final commit + push. Don't accumulate multiple phases' worth of unpushed commits — push at the end of each phase so origin reflects the latest stable state.
