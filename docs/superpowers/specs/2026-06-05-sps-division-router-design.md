# SPS division-aware advanced-standing cap (`get_credit_caps`)

**Date:** 2026-06-05
**Status:** Design — awaiting review
**Scope:** One feature, SPS-only. Follows PR #32 (which gave `sps.json` three scoped `advanced_standing` caps).

## Problem

SPS is administratively one school (`homeSchool: "sps"`) but operationally a federation of divisions — **Schack Institute** (real estate), **Tisch Center** (hospitality), **Tisch Institute** (global sport), and the **Division of Applied Undergraduate Studies (DAUS)** — whose advanced-standing credit cap differs:

| Division / level | Advanced-standing cap | Bulletin |
|---|---|---|
| Schack / Tisch Center / Tisch Institute — bachelor's | 64 | academic-policies L376 |
| DAUS — bachelor's | 80 | L378 |
| DAUS — associate's | 30 | L378 |

PR #32 made `sps.json` carry all three as `advanced_standing` entries scoped via `CreditCap.appliesTo`, and `get_credit_caps` displays **all three** because there is no division signal to auto-select one. So an SPS student asking "what's my advanced-standing cap?" gets three numbers and must self-identify.

**Key facts (verified during brainstorming):**
- The DPR `cumulative` block does **not** carry the advanced-standing cap (only credits/residency/GPA/P-F/outside-home/time-limit) → the config is the only structured source.
- The DPR `programs[]` block **does** name the student's actual program (e.g. `{ programType: "Major", label: "..." }`) → it identifies the division.
- So when a DPR is loaded, the division (and thus the single correct cap) is derivable from data already present.

## Policy constraint: no DPR → no personalized answers

Already enforced at two layers (confirmed, no new work needed):
- **System prompt** `## NO DEGREE PROGRESS REPORT LOADED (mandatory)`: for any personal/record question, do not guess — ask the student to upload the DPR (Albert → Student Center → Academics → Degree Progress Report), then stop; only general/impersonal lookups remain answerable.
- **Tool layer:** `getAcademicStanding` / `planForwardDegree` / `whatIfAudit` / `proposePlanChange` hard-refuse in `validateInput` without a DPR.

This design honors the policy: the *personalized single cap* is produced only when a DPR is present. Without a DPR, `get_credit_caps` shows the three caps as a **general bulletin fact** framed as "depends on your division — upload your DPR for yours," never as a personalized answer.

## Goal

When an SPS student's DPR is loaded, `get_credit_caps` returns the **single** advanced-standing cap for their division when confidence is high; otherwise it signals the agent to **ask which division** the student is in / intends. Non-SPS schools and the no-DPR path are behaviorally unchanged (the no-DPR SPS framing is clarified in the prompt).

## Non-goals

- Not a general division router for other schools — SPS is the only school with division-divergent caps (YAGNI).
- Residency divergence (DAUS 48 vs Schack/Tisch 64) stays **DPR-sourced** (`cumulative.residencyRequired` is per-student).
- No new `StudentProfile` field; no onboarding/UI change.
- The pace/standing rule is school-wide (not divisional) — untouched.

## Design

### Component 1 — `resolveSpsDivision(dpr)` (pure resolver)

New module `packages/engine/src/dpr/spsDivision.ts`. Pure function; no I/O.

- **Input:** `DegreeProgressReport` (reads `programs[]` labels + `cumulative.creditsRequired`).
- **Output** — discriminated union `SpsDivisionVerdict`:
  - `{ confidence: "high", division, degreeLevel: "bachelors" | "associates", advancedStandingCap: 64 | 80 | 30, matchedLabel: string }`
  - `{ confidence: "low", reason: string, options: Array<{ label: string; cap: number }> }`
- `SpsDivision = "schack" | "tisch_center" | "tisch_institute" | "daus"`.

**Logic:**
1. Scan `dpr.programs[]` for a `Major`/`Program` label matching a distinctive **division token** (bulletin-sourced table): `/real estate/i → schack`, `/hospitalit/i → tisch_center`, `/sport/i → tisch_institute`, `/(liberal (studies|arts)|business|information systems|leadership|management|applied)/i → daus`.
2. **Degree level** from the label's degree token (`/\b(bs|ba|bfa)\b/i → bachelors`, `/\b(aa|aas)\b/i → associates`), corroborated by `creditsRequired` band (associate ≤ ~66; bachelor ≥ ~100).
3. **Cap:** Schack / Tisch Center / Tisch Institute → 64; DAUS bachelor's → 80; DAUS associate's → 30.
4. **Confidence = high** iff exactly one division token matches **and** the degree level is unambiguous (a degree token is present, and if `creditsRequired` is present it agrees with the band). Otherwise **low** — career-only label (e.g. "UC-Sch of Prof Studies" with no Major), zero or multiple division matches, or a degree-level conflict — and the verdict returns the three `options` for the agent to ask about.

The division-token table and (critically) the **associate-vs-Tisch-Center assignment** are authored + cited from `data/bulletin-raw/.../professional-studies/programs/` during implementation (see Risk).

### Component 2 — `get_credit_caps` integration

In `getCreditCaps.ts` `call()`: when `homeSchool === "sps"` **and** `session.degreeProgressReport` is present, call `resolveSpsDivision`:
- **high** → add `resolvedAdvancedStanding: { cap, appliesTo, matchedLabel }` to the result and collapse the displayed `crossSchoolCaps` `advanced_standing` entries to the matched one (other cap types untouched).
- **low** → add `needsDivisionClarification: { options }` + a `suggestedFollowUp` instructing the agent to ask which SPS division the student is in / intends.

`summarizeResult` renders:
- resolved → `Advanced-standing cap: 80 credits — DAUS bachelor's (from your DPR program: <label>)`
- low → `Advanced-standing cap depends on your SPS division — confirm which applies: Schack/Tisch bachelor's (64), DAUS bachelor's (80), DAUS associate's (30)`

**No-DPR** (homeSchool `sps`, no DPR): unchanged — displays all three scoped caps; the existing prompt nudges the DPR upload.

### Component 3 — system-prompt touch

In the `get_credit_caps` mention within the "NO DPR" section, add a half-sentence: for SPS the *specific* advanced-standing cap is division-dependent and needs the DPR, so the agent frames the no-DPR answer as general policy + nudges the upload.

## Testing (TDD)

- **Resolver** (`spsDivision.test.ts`): real-estate-BS → schack/64/high; hospitality → tisch_center/64/high; global-sport → tisch_institute/64/high; leadership-BS → daus/80/high; business-AAS → daus/30/high; career-only label → low (3 options); unknown / multi-match → low.
- **Integration** (extend `getCreditCapsSpsDivisions.test.ts`): SPS + DAUS-bachelor DPR → summary shows single "80"; SPS + career-only DPR → summary asks to confirm (lists 3); SPS + no DPR → all three (status quo); non-SPS + DPR → resolver not called / unaffected.
- **Regression — no-DPR policy insurance** (new): assert `getAcademicStanding` and `planForwardDegree` return `ok: false` from `validateInput` without a DPR — locking the policy the user cares about.

## Key risk / assumption

No real **SPS** DPR sample exists in-repo, so the exact PeopleSoft program-label format is inferred (the sample DPR is CAS). **Mitigation:** tolerant token matching + the confident-route-or-ask design degrades any unmatched/ambiguous label to "ask the student," never a wrong number. The division-token list **and** the associate-vs-Tisch-Center division assignment must be verified against the bulletin program pages during implementation; anything unresolved stays low-confidence (ask).

## Files touched

- `packages/engine/src/dpr/spsDivision.ts` (new) + barrel export in `dpr/index.ts` / engine `index.ts` as needed.
- `packages/engine/src/agent/tools/getCreditCaps.ts` (resolver call + result fields + `summarizeResult`).
- `packages/engine/src/agent/systemPrompt.ts` (half-sentence).
- `packages/engine/tests/...` (resolver unit + integration extension + no-DPR regression).
