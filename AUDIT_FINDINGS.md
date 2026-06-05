# NYU Path — Consolidated Issue Findings (final draft)

**Date:** 2026-06-05
**Scope:** the live serving system — `apps/web` + `packages/engine/src` + `packages/shared/src`. Live chat entry: `apps/web/app/api/chat/v2/route.ts` (POST) → `buildStudentProfileFromDpr` (`apps/web/lib/buildSession.ts`) → `runAgentTurnStreaming(primary, buildDefaultRegistry() [20 tools], session)`. Onboarding (pre-DPR) turns go to the legacy `apps/web/app/api/chat/route.ts`; sidebar plan edits go to `apps/web/app/api/plan/*` → `apps/web/lib/planActionOrchestrator.ts`.
**Method:** three independent de-CAS/cleanup audits (8-, 6-, and 7-agent fan-outs) were reconciled, and **every** conflicting / additional / missing claim was re-verified against the **actual executable code**. Comments, docstrings, and `.md` files were **not** accepted as evidence (a comment can be stale or wrong). "Live" means reachable from the production chat path above; test files, `tools/`, `scripts/`, and unimported modules are not live.
**This document lists issues + their fix status.** Each entry gives the issue (what the code does), the location (`file:line`), and the root cause (the "why"). Severity ∈ {🔴 high, 🟠 medium, 🟡 low}. ✅ = confirmed in code · 🔀 = cross-audit conflict resolved in code (Appendix B) · **✔ FIXED** = resolved (with commit + how).

**Fix status (2026-06-05).** A cleanup pass — commits `605978af`, `f3fdc2a9`, `43d9a9ed`, `f14549f8`, + this close-out (all on `main`) — resolved the **dead-code / dead-data / stale-comment** findings by deletion/removal (verified: engine + web `tsc` 0 errors; vitest green throughout, 1416 → 1321 tests as dead-code tests were dropped). **FIXED:** section E DEAD-1, 3–10, 12–23 (everything except the two intentional keeps), plus CAS-11, CAS-13, HARD-7, MISC-3 (each marked **✔ FIXED** below). **STILL OPEN:** only DEAD-2 (kept — build input) and DEAD-11 (deferred — possible unwired feature) in section E; plus **all the behavior/correctness + de-CAS bugs** (CAS-1…10/12/14/15, HARD-1…6, RAG-1, all PLAN-*, all DPR-*, MISC-1/2) — those need the fix phase, not cleanup. The FLAG-UPDATE tests (Appendix D) get updated *with* their linked bug fix.

---

## Root-cause clusters (most findings collapse into these)

- **RC-1 — Home school is guessed and silently defaulted to `cas`.** `buildSession.deriveHomeSchool` has no branch for Shanghai / Abu Dhabi / Nursing and onboarding never confirms it; the `homeSchoolOverride` hook exists but no caller sets it. Cascades into course classification, school-config selection, RAG scope, caps, and labels. (CAS-1, CAS-2, CAS-3, RAG-1.)
- **RC-2 — Multiple divergent school-name/id vocabularies** instead of one source of truth (`schoolDefaults` is canonical, but `courseSuffixMap`, `citationLabels`, `responseValidator`, and `ragScopeFilter` each keep their own partial/competing list). (CAS-2, CAS-9, CAS-10, CAS-11, HARD-1, RAG-1.)
- **RC-3 — The planner reads requirements/labels by keyword-matching DPR text** instead of using the DPR's structured requirement-group hierarchy. (HARD-2, HARD-3.)
- **RC-4 — Two divergent `SolverInput` builders.** `build.ts` (initial plan) runs the full 7-axis validator and threads offerings/coreqs/grad-target; `planChangeHelpers.ts` (propose/confirm edits) skips the validator, drops the grad goal, drops coreqs, and uses a stale current-term heuristic. (PLAN-2, PLAN-3, PLAN-15.)
- **RC-5 — Structural-solver data wired empty / checks stubbed**, so several "validity" guarantees silently pass. (PLAN-1, PLAN-4.)
- **RC-6 — Personalized facts invented or dropped** in `buildSession` / the DPR parser. (DPR-1…DPR-6.)

---

## A. CAS-only behavior still in live code

### CAS-1 🔴 ✅ `deriveHomeSchool` silently defaults to `"cas"`; no Shanghai / Abu Dhabi / Nursing branch; onboarding never confirms
- **Where:** `apps/web/lib/buildSession.ts:182-207` (substring ladder; unmatched → `console.warn` then `return "cas"`). The `homeSchoolOverride` option exists (`buildSession.ts:48`) but no caller sets it — the v2 route threads only `studentIdOverride` + `visaStatus` (`chat/v2/route.ts:211-222`).
- **Issue:** any Shanghai / NYU Abu Dhabi / Nursing student (or any student whose labels don't hit a keyword) is silently typed `cas`. The wrong `homeSchool` then selects the wrong school config (`chat/v2/route.ts:229`), the wrong RAG scope (RAG-1), the wrong caps, and CAS labels — invisibly.
- **Root cause (RC-1):** home school is inferred from free-text with a silent CAS default rather than confirmed at onboarding.

### CAS-2 🔴 ✅ Course classifier `HOME_SCHOOL_TO_SUFFIX` keys don't match the ids `deriveHomeSchool` emits
- **Where:** `packages/engine/src/data/courseSuffixMap.ts:57-65` (keys: cas/stern/tandon/steinhardt/tisch/gallatin/**ls**) vs `buildSession.ts:182-207` (emits `"liberal_studies"`, `"sps"`, never `"ls"`).
- **Issue:** the lookup `HOME_SCHOOL_TO_SUFFIX[homeSchool.toLowerCase()]` (`courseSuffixMap.ts:108`) returns `undefined` for Liberal Studies / SPS / Nursing / Shanghai / Abu Dhabi students, so they can never receive a `home` classification in `search_courses` — every course reads `cross_school`.
- **Root cause (RC-2):** a hand-maintained map keyed on a different vocabulary than the profile builder produces.

### CAS-3 🔴 ✅ Global-site branch runs before the home match → global-campus students' OWN courses labeled "study-abroad-only"
- **Where:** `courseSuffixMap.ts:96-101` (global-site branch, returns *"only available during a study-abroad term"*) executes before the home-suffix check at `:103-107`; home match is brittle string-equality (`meta.school === studentSchool`).
- **Issue:** any `-SHU` (Shanghai) or `-UH` (Abu Dhabi) course short-circuits to `global_site` regardless of the student's home school — a Shanghai student is told their own home-campus course is study-abroad-only. Shown live via `search_courses`.
- **Root cause (RC-2):** branch ordering treats any global-site suffix as foreign before checking whether it is the student's home campus (compounded by CAS-2's missing keys).

### CAS-4 🟠 ✅ Clarifier sub-agent persona hard-codes "NYU CAS", outranking the real school
- **Where:** `packages/engine/src/agent/clarifier.ts:146` (`CLARIFIER_SYSTEM_PROMPT` literal *"…an academic-advising agent at NYU CAS."*, sent live at `:215`); fires on every ambiguity-gated turn (`chat/v2/route.ts:371-402`).
- **Issue:** the clarifier's system identity asserts CAS for students of every school. It receives `studentContext.homeSchool` (`:191`) but only as a separate user-context line; the persona identity stays CAS and outranks it.
- **Root cause:** persona school is a static literal, not interpolated from `homeSchool`.

### CAS-5 🟠 ✅ System prompt asserts an "outside-CAS budget/usage" to every DPR-loaded student
- **Where:** `packages/engine/src/agent/systemPrompt.ts:321,327` — literals inside the unconditional `if (opts.dprLoaded)` block (opens `:313`).
- **Issue:** every live chat turn tells the agent it tracks an "outside-CAS budget" / "outside-CAS usage" — a CAS-specific construct — contradicting the role line ("never assume CAS"). The DPR field is generic (`outsideHome*`; `getCreditCaps` correctly calls it `outsideHomeCapUnits`).
- **Root cause:** CAS-specific labels left in the shared prompt block.

### CAS-6 🟠 ✅ Audit output hard-labels residency as "(CAS)" for all schools
- **Where:** `tools/runFullAudit.ts:376` (*"Residency credits (CAS):"*) and `:129` (*"outside-CAS used + cap"*).
- **Issue:** the residency/outside numbers come from the student's own DPR (school-agnostic), but the literal "CAS" label is wrong for any non-CAS student and leaks into agent-visible output.
- **Root cause:** hardcoded CAS label on school-agnostic DPR values.

### CAS-7 🟠 ✅ DPR cumulative derivation keys off CAS PeopleSoft IDs and injects CAS unit caps — flowing into a live "authoritative" tool
- **Where:** `packages/engine/src/dpr/parser.ts:781-783` (`R1001/35` residency, `R1680/10` P/F, `R1680/30` outside-CAS) and `:800-801` (`parseUnitCap(...) ?? 32` P/F, `?? 16` outside-home). These caps are read live by `tools/getCreditCaps.ts:137-138` and reported as authoritative (`outputMode: "semi_hardened"`, pinned verbatim, `getCreditCaps.ts:38,228-241`).
- **Issue:** for a non-CAS DPR whose requirements carry different R-IDs, these metrics silently become `null` or fall back to the literal CAS caps 32 / 16, then surface as the student's "authoritative" caps.
- **Root cause:** cumulative-metrics map hardcoded to CAS rule IDs + CAS numeric fallbacks (a "no-invention" violation when the DPR is silent). See also DPR-6 (second residency row ignored).

### CAS-8 🟠 ✅ Planner uses CAS / inline defaults instead of per-school config
- **Where:** `forwardSchedule/build.ts:90` (`?? "cas"`), `:71` (`?? 128` degree-credit min), `:73` (`creditTargetPerSemester = 16`, unconditional), `:79` (`domesticPartTimeFloor = 8`); mirrored in `planChangeHelpers.ts:326,332,340`. (For contrast, `maxCreditsPerSemester` and `f1FullTimeMinCredits` *are* read from `schoolConfig` — `build.ts:72,77`.)
- **Issue:** a non-CAS student with a sparse DPR header silently gets a CAS school-id and a 128-credit degree minimum; the per-semester credit target (16) and domestic part-time floor (8) are literals that never vary by school.
- **Root cause:** the planner predates / bypasses the de-CAS'd `schoolDefaults` and defaults unknowns to CAS; two registration constants are not modeled in `SchoolConfig`.

### CAS-9 🟡 ✅ Internal-transfer guardrails fire only for a hardcoded 5-school list
- **Where:** `agent/responseValidator.ts:371` (grounding rule) and `:467` (GPA caveat): `(?:cas|stern|tandon|tisch|steinhardt)`.
- **Issue:** a reply about transferring *to* Gallatin / SPS / Shanghai / NYUAD / Nursing / Liberal Studies matches neither the "must call `search_policy`" grounding rule nor the GPA caveat. **Calibration note:** these are detection patterns on the *model's own output* (to trigger a caveat/guardrail), never strings emitted to the user — so the impact is "a guardrail silently doesn't fire for 6 schools," not user-facing CAS text. (Also HARD-4.)
- **Root cause (RC-2):** closed alternation list of school names instead of deriving from the school set.

### CAS-10 🟡 ✅ Fabricated-attribution check special-cases only "CAS bulletin"
- **Where:** `agent/verifiers/blockquoteAttribution.ts:57` — the attribution regex's only school token is `(?:CAS )?bulletin`; guards skip un-attributed quotes at `:268-269`.
- **Issue:** a fabricated blockquote attributed to "Stern bulletin" / "Tisch bulletin" etc. produces no attribution match, so the guard never checks it against the corpus — a school-biased hole in a fabrication guardrail.
- **Root cause (RC-2):** the school qualifier in the regex is the literal `CAS`, not a general school pattern.

### CAS-11 🟡 ✅ `citationLabels` allowlist is CAS-era and incomplete (and dead)
- **Where:** `agent/citationLabels.ts:18-26` — allowlist `cas, stern, tisch, tandon, steinhardt, silver, gallatin`; omits nyuad/shanghai/sps/liberal_studies/nursing; still lists the defunct `silver`. Dead (DEAD-10).
- **Issue:** a re-CAS / incompleteness hazard if ever wired; harmless today.
- **Root cause (RC-2):** a second hand-maintained school dictionary diverging from `schoolDefaults.SCHOOL_DISPLAY_NAMES`.
- **✔ FIXED** `605978af` — the dead `citationLabels.ts` module was deleted (DEAD-10), removing the stale CAS-era allowlist entirely.

### CAS-12 🟡 ✅ `update_profile` description example value is `"cas"`
- **Where:** `tools/updateProfile.ts:96`. Non-functional; reinforces a CAS default in the model-visible description.

### CAS-13 🟡 ✅ Legacy `-UA → cas` suffix mapper lives in the (dead) transcript path
- **Where:** `packages/engine/src/transcript/profileMapper.ts:38-49` (`SUFFIX_TO_SCHOOL`, `"-UA": "cas"`, consumed `:170`). Dead/test-only (DEAD-3), but a re-CAS hazard if the legacy module is revived.
- **✔ FIXED** `605978af` — the entire `transcript/` dir was deleted (DEAD-3), so the `-UA → cas` mapper is gone.

### CAS-14 🟠 ✅ Recovery-mode message hardcodes the CAS College Advising Center for every school
- **Where:** `packages/engine/src/cohort/gate.ts:151` (*"…the College Advising Center (25 West 4th Street, 5th floor; 212-998-8130)…"*), returned by `runRecoveryMode` (`:136-155`) and emitted live when the cohort gate is failing (`chat/v2/route.ts:469-475`).
- **Issue:** any student in a failing-gate cohort (incl. Tandon / Stern / Shanghai / NYUAD) is sent to the CAS-only advising center address + phone.
- **Root cause:** the "limited availability" copy is unconditional on home school.

### CAS-15 🟡 ✅ SPS division caps hardcoded into the system prompt (no-DPR branch only)
- **Where:** `agent/systemPrompt.ts:420-424` — literal SPS numbers ("Schack/Tisch 64, DAUS 80 bachelor's / 30 associate's") inside the `else` (no-DPR) branch (opens `:403`).
- **Issue:** hardcoded numbers in the prompt softly contradict the Cardinal Rule (every number from a tool). **Scope:** this branch is emitted only when no DPR is loaded; live post-onboarding chat always has a DPR, so it is effectively unreached on the live path — low live impact, but a latent CAS/SPS-specific literal.
- **Root cause:** school-specific figures baked into prompt text instead of coming from RAG/DPR.

---

## B. Hard-coded lists that should be DPR / RAG / data-driven

### HARD-1 🔴 ✅ `courseSuffixMap` duplicates and contradicts `data/schools/*.json#courseSuffix`
- **Where:** `data/courseSuffixMap.ts` (`SUFFIX_META` + `HOME_SCHOOL_TO_SUFFIX`) vs the per-school JSON `courseSuffix` fields.
- **Issue:** the code map both duplicates and disagrees with the school data (e.g. `UF` assigned to Tisch in code while `liberal_studies.json` claims `-UF`), plus the omissions/ordering bugs in CAS-2/CAS-3.
- **Root cause (RC-2):** a hand-maintained constant where the data files are the source of truth.

### HARD-2 🔴 ✅ Requirement category / workload tier derived by substring-matching DPR text
- **Where:** `forwardSchedule/build.ts:352-401` (and `planChangeHelpers.ts:719-725`) — `inferCategory`/`buildProgramRules` return literal `"cs_major_required"` / `"cas_core"` / `"free_elective"` from `blob.includes("major"|"core"|"elective")`.
- **Issue:** whether a requirement is heavy (major/core) or easy (free elective) — which drives the whole workload-balance philosophy — is decided by matching English words in the DPR rId/title. Non-CAS programs whose labels lack those words mis-tier; the returned literals are CAS/CS-flavored.
- **Root cause (RC-3):** category inferred from free text rather than from the DPR's requirement-group hierarchy (which group rolls up to the declared Major vs the College Core `RG5004` vs `General Electives R4000`).

### HARD-3 🟠 ✅ `MAJOR_GROUP_HINTS` keyword blacklist gates a major-related disclaimer
- **Where:** `tools/runFullAudit.ts:594-606` (regex array: `/computer science/`, `/economics/`, `/finance/`, `/engineering/`, `/major/`, …), tested at `:629-630`, gating the "P/F doesn't count toward your major" disclaimer (`hasMajorRequirementGap` → `:651-658`).
- **Issue:** a hardcoded list of mostly-CAS major names (plus the generic `\bmajor\b`) decides whether the disclaimer appears; a major outside the list or with a non-English label won't trip it. Conflicts with the "general fixes only — no keyword blacklists" rule. (Re-verified present after the recent `runFullAudit` edits; the grade-threshold logic was de-hardcoded but this keyword list remains.)
- **Root cause (RC-3):** a keyword heuristic substituting for a structural program-linkage check.

### HARD-4 🟠 ✅ Internal-transfer school regex (same as CAS-9) — `responseValidator.ts:371,467`. A hardcoded closed list; see CAS-9 for the calibration note.

### HARD-5 🟠 ✅ DPR CAS R-ID map + 32/16 caps (same as CAS-7) — `dpr/parser.ts:781-801`. A hardcoded ID→metric table + numeric fallbacks that should come only from the student's own DPR nodes.

### HARD-6 🟡 ✅ Hardcoded CORE-UA pattern forces a specific follow-up
- **Where:** `runFullAudit.ts:591` (regex `/\bCORE-UA\s+\d{3}-\d{3}\b/i` inside `GENERIC_STATUS_TEXT_PATTERNS:586-592`), consumed by `isGenericStatusText` (`:613`) to gate a `search_policy` follow-up (`:667`).
- **Issue:** a CAS-Core-specific catalog-range pattern hardcoded into the generic-prose detector.
- **Root cause (RC-3):** CAS-Core requirement-text format special-cased in code.

### HARD-7 🟡 ✅ `examEquivalencies.ts` is a CAS-only AP/IB table (and dead, DEAD-4) — the DPR already carries earned credit as `type=TE` rows; policy nuance belongs in RAG.
- **✔ FIXED** `605978af` — `examEquivalencies.ts` deleted (DEAD-4).

### RAG-1 🔴 ✅ The cross-school RAG scope filter omits indexed global/health-campus schools
- **Where:** `packages/engine/src/rag/ragScopeFilter.ts:46-56` — `SCHOOL_NAME_PATTERNS` covers only `cas, stern, tandon, tisch, steinhardt, nursing, liberal_studies, gallatin, sps` (9). The scope predicate (`:76,88-91`) admits only `homeSchool` + `"all"` + a matched override. The corpus map `rag/corpus.ts:58-73` (`SCHOOL_DIR_TO_ID`) DOES index `abu-dhabi→nyuad`, `shanghai`, `social-work`, `public-service`, `dentistry`.
- **Issue:** **NYUAD, Shanghai, social_work, public_service, and dentistry chunks are indexed but unreachable via cross-school override** — a CAS student asking about "Abu Dhabi" or "Shanghai" gets no override, so those chunks are filtered out. Combined with CAS-1, a Shanghai student mis-derived as `cas` is scoped to `cas + "all"` and excluded from *their own* indexed pages. (`global_public_health` is absent from *both* the filter and the corpus map — not modeled at all, a separate gap.)
- **Root cause (RC-1/RC-2):** the override-pattern list is a hand-maintained subset of the school set the corpus already indexes.

---

## C. Core planning-engine philosophy gaps

### PLAN-1 🔴 ✅ The course-offerings map is always empty → "terms offered" is never enforced
- **Where:** `forwardSchedule/build.ts:198` and `planChangeHelpers.ts:419` (`offerings: new Map(), offeringConfidence: new Map()`, never populated). The solver consults them (`solver.ts:804,973,1037`) but every `.get()` returns `undefined`, so the guards (`if (offered && offered.length > 0 …)`) short-circuit. `data/courses-offerings.json` (7,963 entries) and `Course.termsOffered` (all 8,558 catalog courses carry it) are never read by the planner (grep across `forwardSchedule/` = empty).
- **Issue:** a fall-only course can be scheduled in spring and reported "valid." Breaks deterministic validity for future-term structural planning.
- **Root cause (RC-5):** the offering data is never wired into `buildSolverInput`; the guards exist but receive empty data. (Note: `courses-offerings.json` is the *fix-data*, not dead — do not delete it.)

### PLAN-2 🔴 ✅ The edit path drops the stated graduation goal, coreqs, and wall-clock dating
- **Where:** `forwardSchedule/planChangeHelpers.ts:363` derives the grad term from credits (`deriveGraduationTermFromCredits`) and never reads `session.graduationTarget` (the initial path honors it — `planForwardDegree.ts:118-120`); `:663-671` infers current term from the last IP row (vs the build path's wall-clock `deriveTemporalContext`, `build.ts:104,267`); and `buildSolverInputFromSession` builds no coreq map (grep `coreq` = empty), so the coreqs `build.ts:143-151,205` threads are dropped on every edit.
- **Issue:** when a student edits a plan, the engine forgets the stated "graduate by X," drops corequisite constraints, and re-introduces the last-IP-row dating the build path was rewritten to avoid — so a plan and its edits can compute different terms.
- **Root cause (RC-4):** `planChangeHelpers` is a partial re-implementation of `build.ts`'s solver-input construction. Violates validity clause #1 ("≤ goal graduation term").

### PLAN-3 🔴 ✅ `propose/confirm_plan_change` bypass the authoritative 7-axis validator
- **Where:** `tools/proposePlanChange.ts:154` / `tools/confirmPlanChange.ts:128` take `state: solverOutput.state` — the solver's *coarse* `derivePlanState` (`solver.ts:598-626`). The full `runGraduationPathValidator` runs only in the build path (`build.ts:238`) and the bind tools (`bindFreeElective.ts:402`, `bindPoolSlot.ts:477`), `reconcile.ts:234` — never in propose/confirm. `build.ts:230` even comments that its own solver state is "coarse (overridden below)." Both the agent and the web `/api/plan/*` sidebar route through these same tools.
- **Issue:** a confirmed *edit* can be written to `session.forwardSchedule` as `valid-clean` without the grad-target / residency / major-credit / upper-level axes being re-checked. The propose/confirm path does re-solve (so prereqs / credit-ceiling / F-1-per-term / conflicts *are* re-checked) but skips the 7-axis validator.
- **Root cause (RC-4):** two planning paths of unequal rigor; the edit path trusts the solver's coarse state.

### PLAN-4 🔴 ✅ The validator counts unbound placeholders as satisfiers and skips the credit-floor axes
- **Where:** `forwardSchedule/graduationPathValidator.ts:124-129,144-145` (an *unbound* placeholder slot is added to `planSatisfiers` and treated as covering its requirement); the live `checkThresholdsMet` at `:280` is gated `if (majorMin !== null)`, but `build.ts:409-411` sets `majorCreditMinimum: null` / `upperLevelMinCredits: null` (also in `solverRules`, `:421-422`; `planChangeHelpers.ts:770-771`), so those axes always pass; residency is likewise null-gated (`:257`).
- **Issue:** "satisfies ALL degree requirements" is overstated two ways: (a) a requirement is considered met by a placeholder with no real course bound; (b) aggregate credit floors (major-credit, upper-level, school-core, residency, minor) are never checked because their thresholds default to `null` and `null → pass`. (The separate `auditOptionality.canDropSlot` major-credit check is dead for a *different* reason — it is uncalled; see DEAD-12.)
- **Root cause (RC-5):** placeholders are intentionally counted as covered, and `buildProgramRules` leaves the threshold axes null, making them no-ops.

### PLAN-5 🔴 ✅ The FOSE live-data set is largely unimplemented
- **Where:** `tools/materializeSections.ts:198-201` (swap hook `async () => null`); `forwardSchedule/solver.ts:588` (`contingencyPlanAvailable: false` hardcoded); `solver.ts:84-99` (`enumerateMainTerms` pushes only fall/spring; the solver never reads `includeSummer`/`includeJTerm`); `forwardSchedule/alternatives.ts:13-20,53,72` (summer/J-term strategies advertise help but return `schedule: null`); `sectionMaterialization/conflictDetection.ts:120-133` (one section per courseId; `schd` LEC/LAB/RCT captured at `types.ts:64-68` but never used to require LEC+RCT co-enroll); `materialize.ts:222-224` (status "W" treated like open; closed sections filtered silently).
- **Issue:** present: open/waitlist/closed status, time-conflict avoidance, section-type, conflict-free combinations, async detection. **Missing (no code path):** Albert auto-swap, the waitlist *number*, campus/location, instruction mode beyond async, instructor preference, recitation (RCT) pairing, summer/J-term enumeration. Summer/J-term are *advertised* in infeasibility messaging the solver cannot produce.
- **Root cause:** the live-data axes, summer/J-term enumeration, and the swap cascade were deferred, but the data shape + advertising strings shipped anyway. (Coverage percentage is the one estimate the rounds disagree on — Appendix C lists the axes, not a number.)

### PLAN-6 🔴 ✅ Greedy single-pass solver with no backtracking
- **Where:** `forwardSchedule/solver.ts:900-901` (`const courseId = filteredCandidates[0]!`), `:1197` (`break` on first placement), `:1200-1211` (on failure emits a placeholder/violation without unwinding prior placements).
- **Issue:** placement is a single forward pass with first-fit commit and no rollback. It can report "infeasible" when a valid plan exists (e.g. two requirements' first-choice candidates collide on the only valid term), and it ships whatever distribution greedy produces rather than searching valid plans.
- **Root cause:** the planner enumerates no alternative valid plans; "preferred" reduces to greedy + load-style ordering. (Verified from control flow, independent of the `// Phase 15 would try all` comments.) Conflicts with "deterministic on validity → among the many valid plans pick the preferred one."

### PLAN-7 🟠 ✅ Workload even-distribution is scored but never enforced
- **Where:** `solver.ts:1512` (`computeBalanceScore` runs *after* placement); placement chooses terms by credit slack (`:970-978`); `balanceScore.ts:103` returns 0 deviation for `loadStyle === "balanced"` but the score only reports. Tier classification itself is faithful (`workloadTier.ts:61-67,149-157`: free-elective = 0.5 easy, major-required/elective/school-core = 1.0 heavy).
- **Issue:** the heavy/easy classification is correct, but balance is a post-hoc diagnostic — it never influences which term a course lands in. "Distribute heavy courses evenly across terms" is measured, not achieved.
- **Root cause:** balance is a reporting metric, not a placement objective.

### PLAN-8 🔴 ✅ The prompt never tells the agent to explain *why* a slot is placed, or which courses are locked vs movable
- **Where:** `agent/systemPrompt.ts` (the DPR-loaded planner block `:323-394` only says which tool to call; no explain-why / locked-vs-movable instruction; the only "explain" directive is scoped to Tier-B alternative selection, `:119`).
- **Issue:** the philosophy requires explaining why each course is planned where it is, and distinguishing locked (taken, immutable) from movable (IP/planned). The prompt instructs neither. **Note:** the *data* exists — the solver attaches per-slot `reason`/`SlotRationale`/`SlotFlexibility` (`solver.ts:1178,1280,852`; `shared/src/types.ts:854-869`), `ForwardSemester.locked` (`types.ts:972`), and `FeasibilityReport.placementRationale` (`types.ts:1026`) — but the agent is never told to surface it.
- **Root cause:** the prompt was trimmed to push routing into tool descriptions; per-slot pedagogy was never added.

### PLAN-9 🟠 ✅ The agent never proactively elicits preferences
- **Where:** `systemPrompt.ts:27-79` (`PREFERENCE_EXTRACTION_RULES` only *handles* volunteered preferences); onboarding (`api/chat/route.ts:133-164`) asks only visa + graduation term. The only `ASK` instructions are clarify-on-ambiguity (`:78`), drop/swap-on-infeasible (`:126`), missing-profile-data (`:255`), upload-DPR (`:414,423`).
- **Issue:** the philosophy says to ask the student for goals/preferences (study-abroad, honors, summer/J-term, workload distribution); nothing solicits them. The system is purely reactive.
- **Root cause:** preference support is a handling pipeline with no goal-elicitation step.

### PLAN-10 🟠 ✅ Risks/trade-offs are not a first-class prompt instruction
- **Where:** `systemPrompt.ts:33` (only a narrow per-mutation "consequences" surface); confidence + verify-with-adviser IS well covered (`:251-253,272-282`).
- **Issue:** the confidence/"verify with your adviser" half of the philosophy clause is enforced; the risk/trade-off half is not — "risk"/"trade-off" never appear as agent directives, though the data layer models `valid-with-trade-offs` (`types.ts:983`).
- **Root cause:** trade-off reasoning lives in solver data/`PlanState` and is never lifted into a prompt rule.

### PLAN-11 🟠 ✅ `get_academic_standing` passes program-count where semesters-completed is expected
- **Where:** `tools/getAcademicStanding.ts:55-56` (`student.declaredPrograms.length` passed positionally) into `audit/academicStanding.ts:113-115` (`semestersCompleted`), which drives tiered-GPA-floor selection (`:195`) and the pace-dismissal gate (`:221`).
- **Issue:** a student's declared-program count (1-3) is fed where the number of completed semesters is expected → wrong GPA tier and dismissal gate for tiered-floor schools (e.g. Tandon).
- **Root cause:** positional argument mismatch.

### PLAN-12 🟠 ✅ Section auto-swap is permanently stubbed
- **Where:** `tools/materializeSections.ts:198-201` (`swapHook = async () => null`); the swap-cascade machinery in `sectionMaterialization/materialize.ts` is never exercised.
- **Issue:** when all open sections of a must-have course are closed, the course is dropped with a message; the Albert-auto-swap "best approach" never runs. (Subset of PLAN-5, called out because a capability is advertised but non-functional.)
- **Root cause:** the hook was deferred and never wired to the solver's candidate set.

### PLAN-13 🟡 ✅ Infeasibility messaging promises options the engine can't compute
- **Where:** `solver.ts:588` (`contingencyPlanAvailable: false`) while `alternatives.ts:53,72` emit "adding a summer/J-term may help"; the solver never enumerates those terms (PLAN-5).
- **Root cause:** advertising strings shipped ahead of the capability.

### PLAN-14 🔴 ✅ The chat route never hydrates the persisted plan/preferences → chat and sidebar disagree
- **Where:** `apps/web/app/api/chat/v2/route.ts:256` attaches `scheduleStore` to the session but never loads a persisted `forwardSchedule` / `studentDraftPlan` / `schedulePreferences` (no `loadLatestSchedule`/`loadPreferences`/restore call — grep returns only the `:256` attach). By contrast `apps/web/lib/planActionOrchestrator.ts` DOES hydrate (`loadLatestSchedule:309`, `loadPreferences:341`, spread into the session `:405-407`). The change-tools refuse when no plan exists (`proposePlanChange.ts:88-94`, `confirmPlanChange.ts:63-69`), and `tools/planForwardDegree.ts:138,149-156` re-solves and overwrites the stored slot.
- **Issue:** a returning student's in-chat "move/drop X" is refused ("No forward plan exists… call plan_forward_degree first"), and `plan_forward_degree` then re-solves with empty pins/exclusions and **overwrites** the persisted, preference-optimized schedule. The sidebar (hydrated) and the chat (un-hydrated) operate on different state. Breaks cross-session continuity.
- **Root cause:** the v2 route bootstraps a fresh session from the DPR only and never reads the persistence layer the `/api/plan/*` routes rely on.

### PLAN-15 🟠 ✅ Plan-change trade-off surfacing is partially hollow
- **Where:** `forwardSchedule/planChangeHelpers.ts:627-634` hardcodes `newRequiresPetition: []`, `newUnmetRequirements: []`, `cascadedShifts: []`, `newAssumptions: []` (always empty), while `forwardSchedule/explainPlanDiff.ts:82,86,90,226-228,233-235` renders its trade-off sentences from exactly those fields. (Credit/balance deltas ARE populated and surfaced — `planChangeHelpers.ts:557,572,611-616`.)
- **Issue:** a plan change that creates a new unmet requirement or requires a petition is never surfaced to the student — only credit/balance deltas are. Violates "apply + state trade-offs."
- **Root cause (RC-4):** `buildPlanDiff` never diffs the before/after requirement-satisfaction or petition sets, so those renderer branches are permanently dead.

---

## D. DPR-personalization gaps (personalized facts invented or dropped)

### DPR-1 🔴 ✅ `get_academic_standing` recomputes GPA instead of reading the DPR's authoritative value
- **Where:** `tools/getAcademicStanding.ts:63` returns `standing.cumulativeGPA`, recomputed from `coursesTaken` by `audit/academicStanding.ts:183`; the DPR's `cumulative.cumulativeGpa` is never read (only the required floor is, `:60`). `academicStanding.ts` has no IP filter (the file never mentions IP).
- **Issue:** the tool re-derives cumulative GPA from course grades — including the synthetic "C" assigned to in-progress rows (DPR-2) — so it can report a *different* GPA than `run_full_audit` (which reads the DPR's number) for the same student, dragged toward 2.0 by ungraded courses.
- **Root cause (RC-6):** GPA recomputed from parsed/synthetic grades rather than read from the DPR.

### DPR-2 🟠 ✅ Synthetic grades invented for gradeless DPR rows
- **Where:** `apps/web/lib/buildSession.ts:88` — `const grade = row.grade ?? (row.type === "IP" ? "C" : "P")`.
- **Issue:** every in-progress course is given a fabricated "C" (= 2.0) and any gradeless non-IP row a "P"; these feed GPA recomputation (DPR-1) and prereq checks, so an ungraded course silently counts as a real grade.
- **Root cause (RC-6):** invented grade fallback (a "no-invention" violation).

### DPR-3 🟠 ✅ Advisor waivers excluded from change-detection and dropped from the profile
- **Where:** `dpr/fingerprint.ts:33-39` hashes only `courseHistory` / `cumulative` / `programs` — `advisorNotations` is not included; and `StudentProfile`/`CourseTaken` (`shared/src/types.ts:483-493,506+`) have no field for it.
- **Issue:** a re-uploaded DPR that adds only a new advisor waiver produces an identical fingerprint, so `refresh-dpr` treats it as unchanged and does not replan; and the waiver is never carried into the profile. Waivers materially change remaining requirements.
- **Root cause (RC-6):** the fingerprint and the profile schema both omit `advisorNotations`.

### DPR-4 🟡 ✅ `repeatCode` dropped from the profile
- **Where:** no `repeatCode` field in `CourseTaken`/`StudentProfile` (`shared/src/types.ts:483-493`); `buildSession.ts` never reads it.
- **Issue:** the DPR's repeat codes (RI / R) drive repeat-grade replacement and GPA treatment; dropping them can mis-handle repeated courses.
- **Root cause (RC-6):** the profile schema omits the repeat code.

### DPR-5 🟠 ✅ Hardcoded 2.0 good-standing floor attributed to the DPR
- **Where:** `tools/runFullAudit.ts:221` (`const inGoodStanding = cumGpa >= 2.0`), message `:228-229` ("…≥ 2.0; you're in good standing per the DPR").
- **Issue:** uses a literal 2.0, ignores the per-student `dpr.cumulative.cumulativeGpaRequired` (which `get_academic_standing` does read) and per-school tiers, and mis-attributes the 2.0 to the DPR. Misadvises higher/tiered-floor schools.
- **Root cause (RC-6):** NYU-wide 2.0 literal mislabeled as DPR-sourced.

### DPR-6 🟠 ✅ The DPR parser reads only one residency row; a joint-major residency requirement is invisible
- **Where:** `dpr/parser.ts` `deriveCumulative` reads only `R1001/35` for residency (`:781,790,817-818`); a joint-major residency row such as `R1142/80` is never read (the only `R1142` references are doc-comment examples in `dpr/schema.ts:93,97,308`). The set of rule IDs read is fixed: `R1001/10, R1001/20, R1001/35, R1680/10, R1680/30, R1680/60`.
- **Issue:** for the sample CS/Math joint major, the DPR carries a joint-major residency requirement (`R1142/80`) that the cumulative derivation cannot see — a real residency requirement is structurally invisible.
- **Root cause (RC-6):** residency is derived from a fixed CAS PeopleSoft rule-ID whitelist rather than by resolving residency rows semantically.

---

## E. Dead code / data (reachability verified by import-graph)

| ID | Path | Fix status | What it was |
|----|------|-----------|----------|
| DEAD-1 | `packages/engine/src/data/course_embeddings.json` | **✔ FIXED** `f14549f8` — deleted | 226 MB gitignored orphan; superseded by `data/course-catalog/*_openai.jsonl`. |
| DEAD-2 | `packages/engine/src/data/course_catalog_full.json` | OPEN — kept | 5.2 MB build-input for `tools/bulletin-parser`; left intentionally (regenerable). |
| DEAD-3 | `packages/engine/src/transcript/` (whole dir) | **✔ FIXED** `605978af` — deleted (dir + phase2/phase3 tests) | legacy text-transcript onboarding; DPR-only now. Also removes the `-UA→cas` mapper (CAS-13). |
| DEAD-4 | `packages/engine/src/data/examEquivalencies.ts` | **✔ FIXED** `605978af` — deleted (+ barrel export) | CAS AP/IB table; DPR carries `type=TE` rows. |
| DEAD-5 | `packages/engine/src/data/tierLoader.ts` + `data/_tiers.json` | **✔ FIXED** `f14549f8` — deleted | program-tier loader; no importer (part of DEAD-16). |
| DEAD-6 | `packages/engine/src/graph/prereqGraph.ts` | **✔ FIXED** `605978af` — deleted (+ barrel; trimmed `courseIdCanon.test`) | only consumer was the dead `graduationRisk`. |
| DEAD-7 | `packages/engine/src/planner/graduationRisk.ts` | **✔ FIXED** `605978af` — deleted (+ barrel) | no live caller; its risk-surfacing idea logged to memory (→ PLAN-10 fix). |
| DEAD-8 | `packages/engine/src/search/availabilityPredictor.ts` | **✔ FIXED** `605978af` — deleted | zero importers; live `searchAvailability` uses `api/nyuClassSearch.ts`. |
| DEAD-9 | `packages/engine/src/equivalence/equivalenceResolver.ts` | **✔ FIXED** `605978af` — deleted (+ barrel) | barrel-only, no consumer. |
| DEAD-10 | `packages/engine/src/agent/citationLabels.ts` | **✔ FIXED** `605978af` — deleted (+ test) | also resolves the CAS-11 hazard. |
| DEAD-11 | `forwardSchedule/reconcile.ts` `reconcileWithDpr` | OPEN — deferred | kept per user; possibly an unwired `refresh-dpr` reconcile feature (`hashDprCourseHistory` stays live). |
| DEAD-12 | `forwardSchedule/auditOptionality.ts` `canDropSlot` | **✔ FIXED** `605978af` — deleted (whole file + test) | uncalled in production. |
| DEAD-13 | `audit/gpaCalculator.ts` `computeMajorGpaByDeptPrefix` | **✔ FIXED** `f3fdc2a9` — removed the unused export | module kept (`computePoolGpa` is live). |
| DEAD-14 | `apps/web/app/chat/page.tsx` `unsupported_major` | **✔ FIXED** `f3fdc2a9` — removed the dangling `OnboardingStep` member | never set or handled. |
| DEAD-15 | `template_match` SSE event path + handler | **✔ FIXED** `43d9a9ed` — removed from both SSE unions + `page.tsx` handler + `agentStatusVerbs` `template:` routing + the 2 dead tests | v2 route never emitted it (Phase 8). |
| DEAD-16 | `data/programs/` + `tools/program-extractor/` + program-tier loaders | **✔ FIXED** `f14549f8` — decommissioned | deleted program JSONs, `program-extractor`, `catalogYearLoader`/`departmentLoader`/`resolveFact` + barrel re-exports, `t2Pipeline` test. Planner reads requirements from the DPR. |
| DEAD-17 | `forwardSchedule/contingencyPlans.ts` `generateContingencies` | **✔ FIXED** `605978af` — deleted (+ test) | test-only. |
| DEAD-18 | `apps/cli/` | **✔ FIXED** close-out — deleted (`rm`; untracked) | build droppings only (no `package.json`/source); not a workspace; zero importers. |
| DEAD-19 | `apps/web/lib/db/schema.ts` `parsed_transcript` column | **✔ FIXED** `f3fdc2a9` — removed the schema field | Drizzle migration still TODO before a DB is provisioned. |
| DEAD-20 | `packages/engine/src/observability/index.ts` (barrel) | **✔ FIXED** close-out — deleted | orphan barrel with zero importers; the engine barrel imports `observability/fallbackLog.js` directly (`index.ts:41,46`), which stays. |
| DEAD-21 | `packages/engine/src/agent/recorderClient.ts` `RecorderLLMClient` | **✔ FIXED** `605978af` — deleted (+ barrel + test) | evals use the sibling `recordingClient.ts`. |
| DEAD-22 | `packages/engine/src/tools/index.ts` + `tools/types.ts` (legacy barrel) | **✔ FIXED** `f3fdc2a9` — deleted (+ root re-export) | zero consumers; live tools use `agent/tool.ts`. |
| DEAD-23 | `scripts/generate-mock-transcript.ts` + `mock_cs_transcript.pdf` | **✔ FIXED** close-out — deleted (`git rm`) | one-off script + its output PDF; no live reader (onboarding is DPR-only). |

> **Not dead (sanity):** `audit/academicStanding.ts` is LIVE (via `get_academic_standing`); `api/nyuClassSearch.ts` is LIVE; `observability/fallbackLog.ts` is LIVE; `recordingClient.ts` is used by evals; the legacy `apps/web/app/api/chat/route.ts` is LIVE for pre-DPR onboarding; `courses-offerings.json` is the PLAN-1 fix-data; the in-memory/file persistence stores are dormant-by-config, not dead.

---

## F. Miscellaneous

### MISC-1 🟡 ✅ Landing page advertises "13,000+" courses; the catalog is ~17,122
- **Where:** `apps/web/app/page.tsx:45` vs the real count in code (`rag/embedder.ts:81`, `tools/semanticCourseSearch.ts:6,111`, `lib/courseCatalogSearch.ts:6` = 17,122). Stale marketing copy.

### MISC-2 🟡 ✅ v1 onboarding hardcodes a `"2027-spring"` graduation default
- **Where:** `apps/web/app/api/chat/route.ts:158` — when the reply matches neither a `(spring|fall|summer) YYYY` nor a bare `202\d` pattern, `graduationTarget` silently defaults to `"2027-spring"`. A per-case literal (also conflicts with "general fixes only").

### MISC-3 🟡 ✅ Stale "template registry" comments (comment-only; the single non-behavioral item)
- **Where:** `apps/web/app/api/chat/v2/route.ts:490-491` (and the stale `runTemplateMatcherOnly` mention `:30-31`); `apps/web/lib/policyRagSetup.ts:11` — both reference a "template registry" / "curated policy templates corpus" that no longer exists. `rag/policySearch.ts` is pure vector RAG (the cited `policySearch.ts:111` is just a `topKVector` parameter).
- **Issue:** no behavioral impact, but the comments misdescribe the system and could lead a maintainer to re-introduce keyword/template routing (which the philosophy forbids).
- **Root cause:** dead comments left from the removed template feature.
- **✔ FIXED** `f3fdc2a9` + `43d9a9ed` — the stale "template registry" / `runTemplateMatcherOnly` comments in `chat/v2/route.ts` + `policyRagSetup.ts` were rewritten to describe the pure-RAG design.

---

## Appendix A — verified-correct (checked, **not** issues)

- **DPR parser, data layer, and RAG corpus are genuinely multi-campus** (14 schools indexed via `SCHOOL_DIR_TO_ID`; CAS ~24%, NYUAD ~11%, Shanghai ~9%; pure RAG, no template routing; provenanced).
- **`schoolDefaults.ts` is correctly de-CAS'd** (school-agnostic floors `DEFAULT_PER_SEMESTER_CEILING=18`, `DEFAULT_F1_FULLTIME_MIN_CREDITS=12`; `schoolDisplayName` falls back to "NYU"; map includes nyuad + shanghai).
- **`get_credit_caps` is DPR-first** (SPS division confidence-gated; unknowns → "confirm with adviser"); **system-prompt role** says "serve undergraduates across all NYU schools… never assume CAS"; Cardinal Rule, DPR-grounding, estimate-framing, IP-vs-final temporal block, and the 4-tier validity-then-preference hierarchy are present.
- **The web/UI layer has no CAS-only strings and no hardcoded school/major dropdowns**; home school is DPR-derived; the UI treats taken = locked / IP & planned = editable; plan-confirm persists to the user's DB keyed on `studentId`; the `/api/plan/*` routes hydrate persisted state.
- **`student-preferred-invalid-draft` works** via the web force-override route (`planActionOrchestrator.ts:586`).
- **The pure-RAG decommission is done** (`check_overlap`, `check_transfer_eligibility`, `plan_semester` removed; `data/transfers/` gone; `preLoopDispatch` keyword router removed — every message enters the agent loop).
- **Confidence + "verify with your adviser"** is well-covered and validator-enforced; production OpenAI embeddings fail closed on a missing key; the persistence split-row bug is fixed (keyed on `auth.sub`).
- **`SAA_STD_DS.pdf` (real-PII DPR) is gitignored** (`.gitignore:52`, under a "PII-containing source DPR PDFs" header) and **not tracked** — PII is correctly kept out of version control. It is a live local fixture for the cohort-eval/diagnostic harness. (Round-3 raised this as a concern; verification shows it's already protected.)

---

## Appendix B — cross-audit conflicts resolved (in code, across all three rounds)

| Topic | Disagreement | Verdict (code) |
|---|---|---|
| `tierLoader.ts` + `_tiers.json` | live vs dead | **DEAD** — no importer; tiers live in `data/schools/*.json`. |
| `graph/prereqGraph.ts` | live vs dead | **DEAD** — only importer is the dead `graduationRisk`. |
| `audit/gpaCalculator.ts` | live vs likely-dead | **LIVE** via `computePoolGpa` (`runFullAudit.ts:322`); only `computeMajorGpaByDeptPrefix` is unused. |
| `search/availabilityPredictor.ts` | "backs the live tool" vs dead | **DEAD** — `searchAvailability` uses `api/nyuClassSearch.ts`. |
| `examEquivalencies.ts` | live-via-barrel vs dead | **DEAD** — a barrel re-export with no symbol consumer is not live. |
| `course_embeddings.json` size | 14 MB vs 225 MB | **226 MB** (225,932,284 bytes). |
| `audit/academicStanding.ts` | live vs dead | **LIVE** — via `get_academic_standing`. |
| `get_academic_standing` bug | GPA recompute (DPR-1) vs `semestersCompleted` arg (PLAN-11) | **Both real** — two distinct bugs in one tool. |
| `student-preferred-invalid-draft` | persisted vs "never emitted" | **Emitted by the web route layer** (`planActionOrchestrator.ts:586`), not the engine. Not a defect. |
| `offerings` map | not raised vs always empty | **CONFIRMED empty** (PLAN-1). |
| propose/confirm validation | "flow validates" vs "skips the validator" | **Re-solves (coarse) but skips the 7-axis validator** (PLAN-3). |
| dead validator axis | "auditOptionality never fires" | The live null-neutered check is in `graduationPathValidator.ts:280` (PLAN-4); `auditOptionality.canDropSlot` is separately dead because uncalled (DEAD-12). |
| `SAA_STD_DS.pdf` PII | "keep out of git" | Already **gitignored** — verified-correct, not a finding. |

---

## Appendix C — the one open judgment item (not a code fact)

**FOSE live-data coverage percentage.** The three rounds estimate the gap differently (e.g. "~70% of live-data axes missing" vs "~45-50% implemented"); they describe the *same* concrete facts (PLAN-5). The number depends on how the axes are weighted, so this document asserts the **axis list, not a percentage**:
- **Present:** open/waitlist/closed status, time-conflict avoidance, section-type capture, conflict-free combinations, async detection.
- **Missing:** Albert auto-swap, waitlist *number*, campus/location, instruction mode beyond async, instructor preference, recitation (LEC+RCT) pairing, summer/J-term enumeration.

*No other conflict, over-claim, or mis-claim remained unresolved after code verification across the three rounds.*

---

## Appendix D — test-suite audit (2026-06-05)

A 7-agent classification of all **128 test files** against the current code + philosophy. **The suite is largely healthy** — ~120 files KEEP (they test live, philosophy-aligned behavior). Removed as DEAD (commit `43d9a9ed`): the dead `template_match` SSE path + its 2 dead `agentStatusVerbs.test.ts` cases; and `agentLoop.live.test.ts`'s removed-symbol imports (`preLoopDispatch`/`loadPolicyTemplates`) + the deleted-template Scenario 1 (kept the 4 live scenarios).

**FLAG-UPDATE — tests that PASS today but should be UPDATED when the linked finding is fixed.** Do NOT trust their current assertion as the *target* behavior; they were NOT deleted because they guard real plumbing or are deliberately frozen:
- `apps/web/tests/buildSessionFromDpr.test.ts` — its IP-row case asserts `grade === "C"`, enshrining **DPR-2** (synthetic grade). `groupCoursesByTerm.test.ts` already asserts the *correct* opposite at the render layer — an internal contradiction. Update when DPR-2 is fixed.
- `packages/engine/tests/eval/dprParser.test.ts` + `dprToAuditResult.test.ts` — golden-test a CAS-CS DPR and bless the hardcoded CAS PeopleSoft R-IDs (R1001/35, R1680/10/30) + `?? 32`/`?? 16` caps + 128-credit min as "the" behavior, with NO non-CAS coverage (**CAS-7, DPR-6**). When the parser is de-CAS'd: parameterize R-IDs/caps by school + add a non-CAS fixture.
- `packages/engine/tests/eval/dataLoader.test.ts` (the `resolveProgramFile` block) + `t2Pipeline.test.ts` — pin the per-major `data/programs` JSON pipeline, the **DEAD-16** decommission target (planner reads requirements from the DPR). Remove together with the `data/programs` decommission.
- Cosmetic stale `plan_semester` labels (removed tool, used only as inert example strings): `evals/tests/composite.test.ts` L206/208 (`forbiddenToolCalls` example), `groundingArithmetic.test.ts` (mock `toolName`), and the **§12.6.5-FROZEN** cohort fixtures `cohort_a.ts:118` + `cohort_a_dpr.ts` (×6, `expectedToolCalls`) — the frozen ones must NOT be edited (the freeze sha256 gate blocks it; `expectedToolCalls` doesn't move the composite). Out-of-`evals/tests` golden files (`evals/golden/*`, `bakeoffRunner` `BAKEOFF_TOOLS`) also still define `plan_semester`/`check_transfer_eligibility` — refresh at the next bakeoff/golden run.
- `legacyDeprecation.test.ts` (KEEP — still a useful "stay-removed" guard) has a stale header comment + now-empty `GRANDFATHERED_CALLERS`; `refusalCascade.test.ts` has a "TWICE" title nit. Cosmetic only.
