# NYU Path — current status (rolling)

`CLAUDE.md` keeps only a one-line pointer to this file; the detailed status lives here so the always-loaded instructions stay lean. **Update this file after each verified-and-confirmed phase** (core philosophy point #6), the same way you revise the matching `Docs/current-system/` doc.

**Last updated:** 2026-06-26

---

## Engine & validator — Phases 0–3 (DONE + merged)

Feasibility-first constraint search + the graduation-path validator (the single definition of "valid") + the tool suite; DPR-first (authoritative), bulletin RAG as cited/hedged tier-2. The frozen engine contract — `finalizeForwardSchedule` + the validator axes + the solver — is the never-touch seam (see `Docs/FROZEN.md`).

## Advisor layer — Phase 3 (DONE + merged, PRs #43–#48)

`probe_counterfactual` (introspection/counterfactual), the plan-claim response-validator check, the soft-objective preference primitive, and proactive elicitation (CORE RULES 12/13) are all live.

## Experience & continuity — Phase 4 (DONE + merged to `main`; plans 33 + 34)

The chat/sidebar share one `useSyncExternalStore` plan-state store; edits are propose→preview→confirm (review card with ✓/⚠/✗ + Confirm/Cancel/Ask-why; invalid → red card, canvas untouched); the structured `OnboardingWizard` is the live `awaiting_dpr` onboarding; pending mutations + confirmed plans persist to Neon (durable `pending_mutations` table, supersede-then-insert) with OTP login + an always-on self-serve delete route. Pre-merge follow-ups: **F2** DPR-derived fields (home school / major-minor / catalog year / courses / grades) are READ-ONLY — change only via a corrected DPR (CORE RULE 14); **F3** IP-course changeability is window-aware + verification-grounded against an owner-correctable per-season academic calendar (`academicCalendar.ts`, cite-or-hedge; per-campus NY / Shanghai / Abu Dhabi), and a claimed current-term drop/withdraw/pass-fail is an unverified draft never recorded as fact until the next DPR (CORE RULE 15). Frozen contract NOT touched.

## Plan 35 — what-if taxonomy + W / pass-fail requirement modeling (DONE; merged to `origin/main` `32cf861`)

The W/pass-fail consequence is **computed**, not just hedged: pure DPR transforms (`applyWithdrawalToDpr` / `applyPassFailToDpr`) edit the DPR *input* and re-run the **unchanged** frozen pipeline; per-school `pfEligibility` makes a **W universal** but **P/F school-specific** (Stern counts toward the major; most schools electives-only; defer/unknown → hedge). Surfaced read-only via `probe_counterfactual` arms and a **confirmable** `propose_whatif_assumption` flow (`/api/plan/whatif`) whose confirm persists **only the `forward_schedule`** — the **binding R1 guardrail**: the authoritative `students.parsed_dpr` is never overwritten by a hypothetical (`assertAuthoritativeDpr` + a byte-identity test enforce it). Three branches (CORE RULE 16): **A** = hypothetical PROGRAM change → upload the Albert What-If audit (`/api/whatif-audit`) as a labeled non-committed exploration; **B** = current-term withdraw/pass-fail; **C** = a confidence-disclaimed estimate. ⚑ Still deferred: exact GPA-of-a-hypothetical-fail; remaining absent calendar windows; DPR parser gaps DPR-2/3/4.

## Plan 36 — Scenarios Workspace UI (DONE; merged to `origin/main` `32cf861`)

3-zone shell (chat rail · ScheduleWorkspace · ProfileRail) over a scenarios model; editing is chat-only; R1 intact. Also fixed a major pre-existing browser-bundling bug via the new `@nyupath/engine/client` client-safe import seam. Plan + mockup: `Docs/plans/36-2026-06-18-scenarios-workspace-ui.md`, `Docs/mockups/scenarios-ui-mockup.html`.

## Plan 37 — slot-editor + per-school P/F validator axis (DONE; merged to `origin/main` `32cf861`)

Slot-editor + 4 actions + the per-school P/F 8th validator axis + never-commit-invalid. One consolidation landed 35 ⊆ 36 ⊆ 37 on the trunk.

## Plan 38 — FOSE section-scheduling (IMPLEMENTED + merged to LOCAL `main` `c667262`; 😴 DORMANT, parked 2026-06-21; NOT pushed to `origin`)

The full section-feasibility capability is done + reviewed (4 adversarial rounds) + merged (`--no-ff`; suite 2820 green; frozen contract + R1 intact): the `materialize_feasible` read-only tool (deterministic, schema-locked candidate set; the agent ranks tool-verified candidates only), multi-component free-pairing + the two-state waitlist backup, the escalation bridge (`sectionReplanBridge` — classify→ladder→re-solve-through-the-FROZEN-seam→honest-no-op) + the `propose_section_replan` tool + the bounded outer loop, the `/api/v2/materialize` route, and the agent-curation guardrails.

**Why dormant:** the public FOSE API never returns live open/waitlist/closed (every section is `stat:"A"` = offered/seat-unknown; live availability is Albert/PeopleSoft-only, behind SSO, no public endpoint — verified 2026-06-20). So the availability-aware features (open≻waitlist ranking, waitlist auto-swap, waitlist counts) are built-but-dormant + honestly hedged (elicit-or-hedge) while the time-conflict + structural value works now. The code stays LIVE (not disabled — it's honest + useful). **Resumption is blocked on an official NYU live-enrollment API** (pursued via NYU IT). When it lands: plug a `SeatStatusProvider` behind the existing seam (no engine rework) + resume the deferred UI (**E2** visual top-5 picker — its own mockup plan; **E5** different-course backup grad-validity). **Until then: no further FOSE work.**
