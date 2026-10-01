# NYU Path — current status (rolling)

`CLAUDE.md` keeps a one-breath status summary + a pointer; the detailed status lives here so the always-loaded instructions stay lean. **Update this file (and that summary in `CLAUDE.md`) in the same PR as the code**, per `CLAUDE.md` §4.1 — the same way you revise the matching `Docs/current-system/` doc (core philosophy point #6).

**Last updated:** 2026-10-01

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

## Plan 38 — FOSE section-scheduling (BUILT + merged to LOCAL `main` `c667262`; ❌ DROPPED from the live agent 2026-07-14, branch `chore/deactivate-fose-live-agent`)

The full section-feasibility capability was built + reviewed (4 adversarial rounds) + merged (`--no-ff`; frozen contract + R1 intact): the `materialize_feasible` read-only tool (deterministic, schema-locked candidate set; the agent ranks tool-verified candidates only), multi-component free-pairing + the two-state waitlist backup, the escalation bridge (`sectionReplanBridge` — classify→ladder→re-solve-through-the-FROZEN-seam→honest-no-op) + the `propose_section_replan` tool + the bounded outer loop, the `/api/v2/materialize` route, and the agent-curation guardrails.

**Dropped from the live agent (2026-07-14):** the two FOSE tools (`materialize_feasible`, `propose_section_replan`) are now **UNREGISTERED** from `ALL_NYUPATH_TOOLS` and their SECTION-FEASIBILITY prompt routing removed, so the live agent no longer offers section-scheduling (registry **24 → 22 live tools**; full suite green; guards: `packages/engine/tests/agent/foseDeactivated.test.ts` + `frozenContractManifest.test.ts`). This is a **disconnection, not a deletion** — the tool code + imports + exports + unit tests remain in the repo (revivable by re-registering + restoring the routing). `materialize_sections` / `confirm_section_combination` (Phase-15/17 core near-term section fill, auto-chained from `plan_forward_degree`) are **unaffected**.

**Why dropped:** the whole capability only becomes genuinely useful with live seat status, and there is **no acceptable source for it**. The public FOSE API never returns open/waitlist/closed (every section is `stat:"A"`; live availability is Albert/PeopleSoft-only, SSO-gated — verified 2026-06-20). Investigated every alternative (2026-07-14): **no official NYU live-enrollment API**; the public PeopleSoft class search that *does* show open/closed is **reCAPTCHA-gated** (defeating it is off-limits + against NYU's intent); and a **student-driven browser helper** (student reads their own Albert page, feeds it in) — while technically viable since the engine's O/W/C machinery is already built — was judged **not worth the build/maintenance/policy cost** for a personal project, and cannot do live monitoring anyway. Without real data the design degrades to a high-friction elicit-or-hedge loop, so the owner dropped FOSE. **No further FOSE work.** The binding philosophy's live-availability mandate is now marked **DORMANT** (conditioned on a seat-data source appearing) — see the FOSE callout at the top of [`core_philosophy.md`](core_philosophy.md).

## Plan 40 — production test suite (PLANNED; nothing implemented)

`Docs/plans/40-2026-09-16-production-test-suite.md` — a comprehensive production evaluation of the whole system (chat agent + 22 tools + web UI), scored on correctness, quality, UI behavior and latency, starting from the real CAS Computer Science/Math DPR. Three harness levels (engine in-process · route + SSE against a production build · Playwright), a 57-category question taxonomy (~1,080 cases), and a binding ground-truth doctrine: every expected answer is re-derived from the DPR text, the bulletin text, or a hand computation — never from the system's own output.

Backed by a 26-agent survey (12 investigators + 12 adversarial skeptics + synthesizer + completeness critic): `Docs/audits/2026-09-17-production-test-capability-survey.md`. **All twelve units came back partially reliable** and about a third of the proposed test seeds were circular, which is why the doctrine above is binding.

**Stage 0 blockers found (each becomes its own PR, none implemented yet):** `next build` fails because the what-if-audit route exports non-route helpers; `tools/bulletin-parser/extractCoreqs.ts` runs its extractor on import, so `vitest` can rewrite `prereqs.json` and spend Anthropic calls; the chat (30/day) and plan-action (60/day) rate limits have no env override; there is no browser test tooling and only three `data-testid` hooks in the whole chat UI.

**Defect ledger:** 50 known-bug watch items and 29 expected-hedge items are tabulated in the plan's §1.5, each with a code citation. The most serious, orchestrator-verified: a six-course "complete all of these" major requirement is modeled as a pick-one pool, so after a hypothetical failure the re-solve drops a still-required course and still returns the plan as valid.

**Rules the DPR does not state (audit 2026-10-01):** `Docs/audits/2026-10-01-dpr-silent-rules-audit.md`, recorded in the plan's §1.7. A DPR cannot carry discretionary or delegated rules (DUS excusals, substitutions, department-website lists, "by advisement" slots), and the bulletin layer fails on them today: both retrieval tools cut off program-page footnotes, the decisive outcome of the owner's MATH-UA 352 / CSCI-UA 421 question exists only on an un-ingested department page, and the system prompt calls the DPR complete. Discretion language appears on ~70% of undergraduate program pages (keyword upper bound). Plan 40 tests this (category C57, KB-40–KB-50, EH-26–EH-29); the fixes go in their own plan. Open owner decision: whether to ingest department pages as a lower-authority source.
