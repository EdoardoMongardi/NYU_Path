# Phase 4 — pre-merge follow-up fixes (F1–F4)

> Drafted 2026-06-16. Status: plan. Owner-directed follow-ups to `33-2026-06-15-planning-engine-phase4-experience.md` (Phase 4 complete on `feat/phase4-experience`), to land **before merge**. Decisions taken with the owner this session; investigation basis = the read-only sweep of current behavior (temporal model, DPR-derived fields, wizard mount).

**North-star unchanged** (`Docs/core_philosophy.md`): DPR is authoritative; never invent a fact or trust an unverified claim as fact; not-~99%-grounded conclusions carry confidence + "verify with your adviser"; deterministic-on-validity then preferred; ALL NYU undergrad (NY + Shanghai + Abu Dhabi).

## Owner decisions (binding)

1. **DPR-derived fields are read-only — enforce fully.** Fields the DPR shows deterministically (home school, declared major/minor, catalog year, courses taken, grades) CANNOT be changed by the wizard or by asking the agent. To change them the student uploads a **corrected/new DPR**. If a student asks to change one, the agent replies "please upload a new DPR" — it never force-changes. The ONLY editable identity/profile cases: **home school when the DPR can't determine it** (the `deriveHomeSchool → "unknown"` fallback), **visa status** (never on a DPR), and **preferences**. Never fabricate data (e.g. a grade).
2. **IP-course changeability is window-aware + verification-grounded.**
   - Final grade on DPR → **locked** (absolute).
   - IP course in a **future** term (pre-registered) → **freely changeable** (it's planning; no real-world registration yet).
   - IP course in the **current** term → classify by NYU's real registration windows (add/drop · withdraw-or-pass/fail · closed), surface the **specific** still-available actions + their consequences, and hedge ("verify with your adviser; not official until your next DPR"). When dates for that term/campus are missing → a generic hedge.
   - **Any claimed change** to a current-term course (drop / withdraw / pass-fail) = an **unverified assumption** — the agent plans around it only as a clearly-marked draft/what-if, never recorded as fact (the DPR is the only thing that confirms a status change). This falls out of decision #1.
   - **DEFERRED (own task, not before merge):** the precise requirement-engine modeling of W / pass-fail consequences (does a W satisfy rule R? does P/F satisfy a letter-grade major rule?). Until then the agent **hedges** that impact rather than computing it.
3. **Calendar data:** research + embed NYU's published per-term deadlines (term start · add/drop · withdraw/pass-fail), per campus (NY / Shanghai / Abu Dhabi), for current + upcoming terms, **scaffolded as an operator-correctable config**; cite the registrar source; missing term/campus → generic hedge. Dates change yearly — config is the source of truth, not hardcoded logic.
4. **Wizard cutover:** mount the **structured** wizard (buttons/dropdowns for discrete choices — school, F-1/domestic, workload, toggles; free-text for open ones — intended major, grad term, free preference) as the LIVE onboarding, replacing the legacy ask-and-reply `awaiting_dpr` flow. No "use chat instead" fallback in this pass (no-dead-end skip-all guarantees a plan is always reachable). Add `@testing-library/react` + `jsdom` (owner-approved dev deps) for a render-level integration test, jsdom scoped to `*.render.test.tsx` only.
5. **Helper extraction dropped:** the `persistProfileFieldCorrection` dedup is moot — under #1 the home-school and visa save-paths now diverge (different gates).
6. **Fresh DB** confirmed as the supported deploy path (runbook already documents it).

## Engine-touch justification (the "frozen engine" exception)

Phase 4 kept `packages/engine` untouched (no solver/validator changes). F2/F3 add: a small agent **CORE RULE** in `systemPrompt.ts` (DPR-derived-field authority), and a NEW additive **academic-calendar + IP-changeability classification** module. Neither touches `finalizeForwardSchedule` / `runGraduationPathValidator` / the solver — they are philosophy-enforcement + a new read-only classifier. Validity-is-a-contract is preserved.

## Tasks

### F2 — DPR-derived field enforcement (read-only + agent re-upload redirect)
- *Goal:* a DPR-derived field cannot be overridden via the wizard or the agent; the agent redirects to "upload a new DPR." Home school is editable ONLY when `deriveHomeSchool` returned `"unknown"`; visa + preferences stay editable.
- *Seams:* (a) v2 route home-school persist block — gate the override on "DPR-derived value was `unknown`"; (b) `OnboardingWizard.tsx` Confirm-profile step — show a confidently-derived school READ-ONLY ("from your DPR — upload a corrected DPR to change"), prompt only on `unknown`; (c) a CORE RULE in `packages/engine/src/agent/systemPrompt.ts` instructing the agent to refuse DPR-derived-field changes + ask for a re-upload; (d) optional hard guard in `updateProfile.ts` (catalogYear/declaredPrograms) comparing the proposed value to the DPR-derived value on `session.student`, refusing + messaging on mismatch.
- *Tests:* the override-when-confident is rejected (route); the wizard renders school read-only when derived; an agent-tool guard refuses a DPR-derived change. visaStatus + the unknown-school fallback still persist.

### F3 — IP-course temporal model (foundation + calendar windows)
- *Goal:* classify each IP course's changeability per the decision-#2 model; surface honest, window-aware, verification-grounded states; fix the slot label/behavior tension.
- *Seams:* (a) NEW academic-calendar config (per campus/term: start · add/drop · withdraw deadlines) + a `classifyIpChangeability(row, temporalContext, calendar)` helper in the engine returning `{ window: "add_drop" | "withdraw_pf" | "closed" | "future" | "unknown", editable, hedge?, rationale }`; reuse `deriveTemporalContext` (`enrolledNowTerm` vs `preRegisteredTerms`); (b) `slotState.ts` consumes the classification → editable + an honest label/hedge (current-term within-window vs closed vs future vs unknown); (c) the agent surfaces the unverified-claim grounding (a current-course change is a hedged assumption, never fact) — a CORE-RULE line + the confidence rail.
- *Tests:* future-term IP → freely changeable; current-term IP within add/drop → changeable; within withdraw window → withdraw/PF surfaced + hedged; closed → locked + hedge; missing dates → generic hedge; a claimed current-course change is never recorded as fact. DEFER (flag) the W/P-F→requirement-satisfaction modeling.

### F1 — Wizard cutover/mount (+ DOM harness + render test)
- *Goal:* the structured wizard is the live onboarding; its Confirm-profile step honors F2; a render-level test proves mount + v2 handoff.
- *Seams:* add `@testing-library/react` + `jsdom` dev deps + vitest jsdom env for `*.render.test.tsx`; import + render `<OnboardingWizard onReachPlan={handleWizardReachPlan} onPreviewIntendedMajor={handleIntendedMajorPreview} />` at the `awaiting_dpr` block in `page.tsx`; verify the automatic handoff to `onboardingStep="complete"` + v2 SSE; a focused `mountedWizard.render.test.tsx`.
- *Tests:* the render test (mount → step flow → "Build my plan" → handoff). Existing wizard unit tests stay green.

### F4 — Docs + plan finalization
- Update `Docs/current-system/web/*` (chat-ui-client, session-and-onboarding-routes, ui-components, build-session, plan-action-orchestrator if touched) + `Docs/core_philosophy.md`-adjacent notes for the DPR-authority + IP-window behavior; mark this plan COMPLETE; update the project memory. Per philosophy #6.

## Verification gates (per task)
Subagent-driven TDD; RED-before-GREEN; full `vitest` green at root; `cd apps/web && npx tsc --noEmit` 3× (+ `packages/engine` 3× when engine touched); 0 `.js` shadows; scoped commits with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer; branch `feat/phase4-experience`; preserve `pnpm-lock.yaml`; do not push/merge.
