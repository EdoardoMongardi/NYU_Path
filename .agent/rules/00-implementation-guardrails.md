---
trigger: manual
---

# NYU CAS CS BA Advisor — Implementation Guardrails

**This rule is ALWAYS active for every implementation task in this project.**

## Mandatory Constraints

1. **All academic rules come from `Original rules/` only.**
   The five files in `Original rules/` are the single source of truth:
   - `Major rules CS BA major`
   - `CAS core rules.md`
   - `General CAS academic rules.md`
   - `General rules for transfer credits.md`
   - `F1 student rule.md`

2. **NEVER invent rules.** Do not add academic policies, constraints, credit limits, exemptions, or equivalencies that cannot be traced to a specific passage in the five source files above.

3. **NEVER search the web** for additional NYU policies or academic rules. The five source files are complete and authoritative.

4. **ALWAYS load the skill** at `.agent/skills/nyu-rules/SKILL.md` before making any implementation change. This skill provides:
   - The exact mapping of every rule to its source file
   - Whether each rule should be deterministic code or LLM context
   - The architecture (Code Layer → LLM Layer) that must be followed
   - The complete AP/IB/A-Level equivalency reference

5. **Code vs LLM boundary:**
   - Any rule with a **binary, computable answer** → deterministic code (never LLM)
   - Explanations, advice, and policy Q&A → LLM context (derived strictly from source files)
   - The LLM must **NEVER contradict** code-computed results

6. **Before committing any change**, verify:
   - [ ] Every new rule/constraint traces to a specific passage in `Original rules/`
   - [ ] No policies were invented or assumed
   - [ ] Deterministic rules are in code, not delegated to LLM
   - [ ] LLM prompt text is derived from source files, not fabricated
