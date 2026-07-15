# NYU Path — agent instructions

## Read this first (binding)

**Before ANY work on this repo — planning, editing, building, reviewing, answering — read [`Docs/core_philosophy.md`](Docs/core_philosophy.md).** It is the project's binding north-star and every decision here serves it. In one breath: the agent must behave like a **professional human academic adviser for ALL NYU undergrad** (including NYU Shanghai + NYU Abu Dhabi — never CAS-only); course plans are **deterministic on validity, then preferred**; any conclusion that is not ~99% grounded/computed carries a **confidence level + "verify with your adviser,"** and the agent **never invents a fact or ships an invalid plan**; identify risk / state trade-offs on agent- and student-proposed decisions **whenever it is necessary to let the student know**.

**Philosophy point #6 (doc discipline — binding):** every plan + audit file goes in its correct `Docs/` slot, and the matching `Docs/current-system/` doc is updated **in the same PR as the code it describes** (see §4.1) — keeping the docs in sync with the code.

## Where things are

- All documentation lives under [`Docs/`](Docs/) — start at [`Docs/README.md`](Docs/README.md).
  - `Docs/STATUS.md` — **rolling current status** (what's done / in-progress / blocked). This file keeps a one-breath summary (§Current status) plus the pointer; update **both** per §4.1.
  - `Docs/index.json` — **machine-readable retrieval index**: concept → spec → implementation → tests, path-verified. Query it (grep/jq) before any code exploration spanning more than one file/module, and before every audit.
  - `Docs/FROZEN.md` — the **frozen engine contract + R1 guardrail manifest**: the exact files/symbols that must never change and the tests that guard them (executable guard: `packages/engine/tests/agent/frozenContractManifest.test.ts`).
  - `Docs/GLOSSARY.md` — one-line definitions of the in-house jargon (DPR, FOSE, R1, the 8 axes, pool slot, tier 1/2, what-if branches).
  - `Docs/current-system/` — how the system works **today** (`engine/` · `tools/` · `web/` · `surrounding/`), kept in sync with code per §4.1.
  - `Docs/specs/2026-06-05-planning-engine-rebuild-design.md` — the canonical architecture.
  - `Docs/plans/` — implementation plans in planned order. **Latest implemented:** `38-…-fose-section-scheduling-replan.md` (❌ DROPPED — see [`Docs/STATUS.md`](Docs/STATUS.md)). Prior: `35`/`36`/`37`, `33`/`34`.
  - `Docs/audits/` · `Docs/reports/` · `Docs/reference/` · `Docs/deprecated/`.
- Code: `apps/web` (Next.js), `packages/engine` (agent loop + 22 tools + constraint-search planner + 8-axis validator), `packages/shared`, `data/`, `tools/`, `evals/`.

## Current status

**Full detail: [`Docs/STATUS.md`](Docs/STATUS.md)** (update it + the summary below per §4.1). In one breath: planning-engine **Phases 0–4 are DONE + merged** (feasibility-first constraint search + the graduation-path validator + the tool suite + the advisor layer + the experience/continuity layer). **Plans 35 / 36 / 37** (what-if taxonomy + W/pass-fail modeling · scenarios workspace UI · slot-editor + per-school P/F validator axis) are **DONE + on `origin/main` `32cf861`**. **Plan 38 — FOSE section-scheduling** was built + merged to **LOCAL** `main` `c667262`, then **❌ DROPPED from the live agent** (2026-07-14, branch `chore/deactivate-fose-live-agent`): the two FOSE tools (`materialize_feasible`, `propose_section_replan`) are **UNREGISTERED** and their prompt routing removed (registry dropped 24→22), so the agent no longer offers section-scheduling. This is a **disconnection, not a deletion** — the tool code + exports + unit tests remain (guard: `packages/engine/tests/agent/foseDeactivated.test.ts`). **Why dropped:** no acceptable live-seat-data source (no official NYU live-enrollment API; the public class search that shows open/closed is reCAPTCHA-gated; a student-driven browser helper isn't worth the cost). `materialize_sections` (core near-term section fill — legacy Phases 15/17, `Docs/plans/17-PHASE_15_PLAN.md` / `19-PHASE_17_PLAN.md`) is **unaffected**. **No further FOSE work** — the philosophy's live-availability mandate is knowingly conditioned/dormant (see the amended [`Docs/core_philosophy.md`](Docs/core_philosophy.md)). The **frozen engine contract** and the **R1 guardrail** are intact throughout.

## Conventions

- **The working code is the source of truth** — never trust a stale comment or doc over the implementation. Precedence when describing behavior: cite the governing doc/§, but where doc and code diverge, the **code wins** — report the divergence as a spec gap with both citations; never assert behavior from neither.
- **Verify before claiming done** (required for any change touching code; doc-only changes need none): `cd packages/engine && npx tsc --noEmit`; `cd apps/web && npx tsc --noEmit`; `npx vitest run` (repo root). Run **both** `tsc` passes every time — a change in one package can break the other. Never `tsc -b` (it emits `.js` shadows **that** vitest then runs instead of the `.ts` sources).
- **Model (the NYU Path product's runtime LLM — not you, the coding agent):** default primary `claude-sonnet-4-6` (override `NYUPATH_PRIMARY_MODEL`); fallback `gpt-4.1-mini`.
- **Dispatching agents/workflows:** see §3 (Multi-agent driven execution).

## Getting started

- **Install:** `pnpm install` (pnpm 9; Node ≥ 18). `@nyupath/engine` resolves to TypeScript source, so no build step is needed to typecheck or test.
- **Run the app:** `cd apps/web && pnpm dev` (Next.js dev server).
- **Env:** copy `.env.example` → `.env.local` at the repo root (apps/web reads a copy). Everything runs test-only without secrets; real logins need `RESEND_API_KEY` + `SECRET_KEY`, and persistence needs `DATABASE_URL` (omit it to use the in-memory store).
- **One test file / one test:** `npx vitest run <path>` (e.g. `npx vitest run packages/engine/tests/agent/frozenContractManifest.test.ts`) or `npx vitest run -t "<name substring>"`.
- **Sample DPRs:** real PDFs `SAA_STD_DS.pdf` / `SAA_STD_DS_WHATIF.pdf` at the repo root; redacted parser fixtures in `packages/engine/tests/fixtures/` (`dpr_sample.redacted.txt` + `dpr_sample.expected.json`); synthetic planning profiles in `packages/engine/tests/eval/profiles/`.
- **CI:** `.github/workflows/ci.yml` runs the §Conventions verify sequence (both `tsc --noEmit` + `vitest run`) on every PR — the mechanical enforcement of "green".

## Implementation guardrails

### 1. The spine — superpowers, one skill per phase

The **brainstorming → writing-plans → TDD** steps apply to any change that **adds or modifies code behavior**. Doc-only or mechanical one-line changes skip those three, but still go through §4 (branch → PR → review) and verification-before-completion.

- **brainstorming** → design spec.
- **writing-plans** → a concrete, test-first implementation plan, per stage.
- **subagent-driven-development** (execute the plan within the current session) **or executing-plans** (hand it to a separate/fresh session) → execute task-by-task with review checkpoints.
- **test-driven-development** → failing test first, then the minimal code to pass it. If it isn't tested, it isn't done.
- **verification-before-completion** → run it, show the evidence; never claim "done/passing" without the command + output (the commands live in §Conventions).
- **requesting- / receiving-code-review** → treat feedback with technical rigor, not performative agreement. The review gate + its timing live in §4.1.

### 2. gstack

Use its skills alongside the superpowers spine:
- **/review** — paranoid production-bug review; run before opening a PR (see §4.1).
- **/investigate** — systematic root-cause debugging.
- **/qa** — automated QA; run on any PR that changes user-facing `apps/web` behavior, before requesting review.
- **/cso** — OWASP + STRIDE security pass; run on any PR that touches credential-handling or web-scraping code (recurring, not a one-time gate).

### 3. Multi-agent driven execution (the least-hallucination engine)

Use the **Workflow tool (multi-agent fan-out)** — not solo generation — for any **load-bearing** research, review, or verification that spans **multiple units** (a single-file lookup or a routine test run never needs it):
- **One agent per unit** (per module / per finding / per tool decision).
- **Adversarial verification** — independent agents try to *refute* each claim/finding before it's accepted.
- **Structured outputs (JSON Schema) + validation** so every result is machine-checkable, not prose to eyeball.
- **Small-chunk processing** — keep each agent's slice small to bound LLM error.
- **Synthesis + a completeness critic** to catch what's missing.

Examples (not an exhaustive trigger list): external tool/pricing vetting (web-verify per §5), multi-lens code review, per-stage QC.

**Dispatching discipline (large-repo):** pin every subagent to the absolute path `/Users/edoardomongardi/Desktop/Ideas/NYU_Path` (the underscore clone — there is a stale space-named clone). Hand it a curated **context packet** (the authoritative files for its task, typically 3–5, per `Docs/index.json`) and tell it to **cite the governing doc/§ or report a spec gap — never infer behavior** (precedence: §Conventions source-of-truth). Have it return a tight structured result, or write a report under `Docs/reports/` and return only the path — never raw dumps. For a broad audit/retrieval over the ~150k-LOC tree (2+ subsystems or 10+ files), use a **fan-out → adversarial-verify workflow** (one agent per subsystem, then a skeptic per finding) scoped via `Docs/index.json`, not one long session — keep the orchestrator holding pointers, not file contents.

### 4. Branch → PR → merge

- **One branch per feature/improvement/fix**, regardless of size; every change to `main` goes through a branch + PR (no direct commits to `main`, no exceptions).
- **No stacked PRs.**
- **Stage selectively, per-file** — never `git add -A`, and never stage or revert files you did not change for the task at hand.
- **End commit messages** with a `Co-Authored-By:` trailer naming the model that actually authored the commit (the harness default trailer).
- **Merge to `main`** only when §4.1 is satisfied.

#### 4.1 Definition of Done — every PR

A PR isn't done until it includes, **in the same PR**:
- the **code and its unit tests** (doc-only / config-only PRs are exempt from this item);
- the **§Conventions verify commands pass** on the branch tip (both `tsc --noEmit` runs + `vitest run`) — this is what "green" means;
- **gstack `/review` clean** — run before opening the PR and iterate until every finding is fixed or explicitly waived by Edoardo (this run satisfies the superpowers requesting-code-review step; process feedback per receiving-code-review);
- **Edoardo's explicit approval** (in chat or on the GitHub PR);
- **all related docs updated** — `Docs/current-system/`, `Docs/STATUS.md` + the §Current-status summary in this file, the root `README.md` if setup or system shape changed, `Docs/index.json` + `Docs/FROZEN.md` if code moved or the frozen seam changed, the PR's plan file reconciled with what was actually built, and the design spec if it changed.

### 5. Least-hallucination practices (non-negotiable)

The other pillars live in §1 (TDD + verification-before-completion) and §3 (multi-agent bounding of LLM error). The rule that lives only here:
- **Web-verify churn-prone external facts** a decision depends on — tool capabilities, pricing, model names/ids, API behavior (exemplary list); the training cutoff is stale, so verify against primary sources before asserting. Stable common knowledge needs no lookup.

### 6. Handoff

- **At every completed-task boundary** (a merged PR or a finished plan stage), offer Edoardo a ready-to-paste prompt for a fresh session (current state + next step) — a clean restart keeps quality high; don't wait for the context limit.
- **Context limit:** when remaining context runs low (or the harness signals imminent compaction), stop starting new tasks, checkpoint state into `Docs/STATUS.md`/Docs, and prepare the handoff prompt — don't push a degraded long session.
