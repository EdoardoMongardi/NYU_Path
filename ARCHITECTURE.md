# NYU Path — Production Architecture & System Design

> **Version:** 3.1  
> **Date:** April 2025  
> **Status:** Approved — canonical reference for all implementation work  
> **Supersedes:** architecture_v2.md, implementation_plan.md  
> **Changelog:** v3.1 adds hardening classification (§2.4), curated policy templates (§5.5), tool invocation auditing (§9.1 Part 4b), completeness checker (§9.1 Part 4c), and formal correctness specification (Appendix D)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Design Philosophy](#2-design-philosophy)
3. [The Hybrid Architecture](#3-the-hybrid-architecture)
4. [Deterministic Engine](#4-deterministic-engine)
5. [RAG Pipeline](#5-rag-pipeline)
6. [Agent Orchestrator](#6-agent-orchestrator-the-loop)
7. [Tool Definitions](#7-tool-definitions)
8. [Planning Pipeline](#8-planning-pipeline)
9. [Safety & Fallback System](#9-safety--fallback-system)
10. [Deterministic vs RAG Decision Matrix](#10-deterministic-vs-rag-decision-matrix)
11. [Data Architecture](#11-data-architecture)
12. [Migration Roadmap](#12-migration-roadmap)
13. [Appendix A: System Prompt](#appendix-a-system-prompt)
14. [Appendix B: Data Model](#appendix-b-data-model)
15. [Appendix C: Policy Gaps Registry](#appendix-c-policy-gaps-registry-g1g45)
16. [Appendix D: Formal Correctness Specification](#appendix-d-formal-correctness-specification)

---

## Claude Code Reference Index

> **Source base:** `~/Desktop/claude-code-leak/recovered-src/src/`
>
> The following files from the Claude Code source code informed our architecture.
> During implementation, study each file for the cited patterns.

| File | Lines | What We Borrow | Our File |
|------|-------|----------------|----------|
| `query.ts` | L219-280 (state init), L307-863 (main loop), L1360-1410 (tool execution), L1715-1728 (loop continuation) | **The agentic `while(true)` loop** — mutable `State` object, `needsFollowUp` flag, tool results → append to messages → loop | `agentOrchestrator.ts` |
| `Tool.ts` | L362-466 (Tool type), L489-492 (`validateInput`), L518-523 (`prompt()`), L321-336 (`ToolResult<T>`), L466 (`maxResultSizeChars`) | **Tool interface** — typed interface with `validateInput()`, `prompt()`, `maxResultSizeChars`, `isReadOnly`, `isConcurrencySafe` | `toolRegistry.ts` |
| `Tool.ts` | L703-792 (`buildTool()`, `TOOL_DEFAULTS`, `ToolDef`) | **Tool factory with safe defaults** — `isConcurrencySafe → false`, `isReadOnly → false`, `isEnabled → true`. Fail-closed. | `toolRegistry.ts` |
| `tools.ts` | L193-251 (`getAllBaseTools()`), L345-367 (`assembleToolPool()`) | **Tool registration** — single source of truth for all tools, sorted for cache stability | `toolRegistry.ts` |
| `services/tools/toolOrchestration.ts` | L19-82 (`runTools` generator), L91-116 (`partitionToolCalls`) | **Tool concurrency** — partition tools into concurrent-safe batches vs serial. Read-only tools run in parallel. | `agentOrchestrator.ts` |
| `services/tools/StreamingToolExecutor.ts` | L40-124 (class, `addTool`), L265-405 (`executeTool`), L453-490 (`getRemainingResults`) | **Streaming tool execution** — tools start executing while model streams, results buffered in order. Phase 4+ optimization. | Future |
| `coordinator/coordinatorMode.ts` | L111-369 (`getCoordinatorSystemPrompt`) | **Multi-agent coordinator-worker pattern** — self-contained prompts, synthesis responsibility, parallel spawning | Future (Phase 5+) |
| `tools/AgentTool/prompt.ts` | L99-113 ("Writing the prompt" section), L66-98 ("When to fork" section) | **Self-contained tool prompts** — "brief the agent like a colleague who just walked in", never delegate understanding | `systemPrompt.ts` |
| `query/deps.ts` | L21-40 (`QueryDeps` type, `productionDeps()`) | **Dependency injection** — inject `callModel`, `autocompact`, `uuid` so tests can swap fakes without spyOn | All modules |
| `context.ts` | L116-189 (`getSystemContext`, `getUserContext`) | **Dynamic context injection** — memoized system/user context appended before each query | `agentOrchestrator.ts` |
| `query/stopHooks.ts` | Full file (370 lines) | **Post-response hooks** — run validators after model responds, inject blocking errors → re-prompt | `responseValidator.ts` |
| `query.ts` | L1062-1357 (stop hooks, recovery, budget) | **Error recovery cascade** — max_output_tokens → escalate → retry → give up; prompt-too-long → collapse → compact → surface | `agentOrchestrator.ts` |

---

## 1. System Overview

NYU Path is an AI-powered academic advising platform for NYU undergraduate students across all schools (CAS, Stern, Tandon, Tisch, Steinhardt, Gallatin, SPS, Silver, Nursing, Liberal Studies, and more). It provides:

- **Degree auditing** — progress tracking across majors, minors, and school-specific core/shared requirements
- **Semester planning** — prerequisite-aware, availability-aware course recommendations
- **Policy Q&A** — natural language answers about NYU academic policies (per-school)
- **Risk detection** — graduation timeline, SAP, and enrollment warnings
- **Transfer eligibility** — internal school-to-school transfer prerequisite checking
- **What-if analysis** — hypothetical major exploration and comparison

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          USER (Student)                             │
│                     chat / transcript upload                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    AGENT ORCHESTRATOR (The Loop)                     │
│                                                                     │
│  ┌──────────┐    Calls tools based on LLM decisions.               │
│  │   LLM    │    Validates inputs/outputs. Handles errors.          │
│  │(GPT-4o)  │    Asks user for missing data.                        │
│  └────┬─────┘    Synthesizes tool results into responses.           │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                     TOOL INTERFACE                            │   │
│  │                                                              │   │
│  │  ┌─────────────┐  ┌───────────────┐  ┌─────────────────┐   │   │
│  │  │run_full_audit│  │ plan_semester │  │  search_policy  │   │   │
│  │  │(deterministic)│  │(deterministic)│  │ (RAG + Rerank) │   │   │
│  │  └──────┬───────┘  └──────┬────────┘  └────────┬────────┘   │   │
│  │         │                 │                     │            │   │
│  │  ┌──────┴─────┐  ┌───────┴────────┐  ┌────────┴────────┐   │   │
│  │  │check_overlap│  │search_courses │  │get_credit_caps  │   │   │
│  │  │(deterministic)│ │(semantic+FOSE)│  │(deterministic)  │   │   │
│  │  └─────────────┘  └──────────────┘  └─────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              RESPONSE VALIDATOR (post-LLM check)             │   │
│  │  • No ungrounded numbers • No uncited policies               │   │
│  │  • No "all done" unless audit confirms • No hallucinated GPA │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA LAYER                                   │
│                                                                     │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ programs/  │  │courses.json│  │ prereqs.json │  │  policy   │  │
│  │ per-major  │  │(full FOSE) │  │ (by dept)    │  │embeddings │  │
│  │   JSON     │  │            │  │              │  │(chunked)  │  │
│  └────────────┘  └────────────┘  └──────────────┘  └───────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Design Philosophy

### 2.1 The Cardinal Rule

> **The LLM NEVER computes. It orchestrates tools that compute.**

Every number a student sees (GPA, credits remaining, completion rate) comes from a deterministic tool. The LLM's job is to decide WHICH tool to call, WHEN, and to synthesize the results into a human response. If the LLM catches itself about to write a number that didn't come from a tool, it must stop and call the tool.

### 2.2 Deterministic vs RAG — The Scaling Principle

> **If a rule can be expressed as data (JSON) and evaluated by a generic engine, it's deterministic.**  
> **If a rule varies by department, changes frequently, or requires natural language understanding, it's RAG.**

For **one major**, we could hand-code every rule. But for **60+ majors**, we need:
- A **generic rule evaluator** that reads per-major JSON files
- A **RAG pipeline** that searches policy documents for department-specific nuances
- An **agent** that knows when each is appropriate

The key insight: **we write code ONCE for the engine. The rules themselves are data files.** Adding a new major means adding a JSON file, not writing new code.

### 2.3 Correctness Guarantees

| Layer | Guarantee | How |
|-------|-----------|-----|
| Deterministic Engine | 100% correct for everything it can compute | Unit tests, eval suite |
| RAG Pipeline | Best-effort with confidence scores | Cohere Rerank, threshold gating |
| Agent Response | No hallucinations in final output | Response validator, re-prompt on failure |
| Missing Data | System never guesses | Asks user, admits limitation |

### 2.4 Hardening Classification — Computable vs. Reasoned

> **Principle:** If a question has ONE correct answer that can be computed deterministically, the response MUST bypass LLM synthesis and use a deterministic output + template. If the question requires multi-factor reasoning, synthesis, or judgment, it stays agentic.
>
> **Why this matters:** The most dangerous failure mode in academic advising is not hallucination — it's **omission** (correct but incomplete advice). The second most dangerous is **inconsistency** (same question, different answers). Both are caused by unnecessary LLM synthesis on questions that don't need it.

| Task | Mode | Output Method | Rationale |
|------|------|---------------|----------|
| F-1 enrollment compliance | **Hardened** | `get_enrollment_status` → template | Legal consequences. Zero tolerance for synthesis error. |
| "How many credits do I need?" | **Hardened** | `run_full_audit` → template | Pure computation. LLM synthesis adds risk, zero value. |
| "Am I on track to graduate?" | **Hardened** | `run_full_audit` → structured output | Boolean + list. No reason for free-text synthesis. |
| SAP / academic standing | **Hardened** | `get_academic_standing` → template | Financial aid consequences. Must be exact. |
| P/F eligibility check | **Semi-hardened** | `get_credit_caps` → template + LLM context | Deterministic check, but implications need context. |
| "What should I take next?" | **Agentic** | LLM synthesis | Multi-factor: audit + prereqs + preferences + risk. |
| "Explain the study abroad policy" | **Agentic** | RAG + LLM synthesis | Open-ended comprehension. Templates can't cover all variations. |
| "Should I add a minor?" | **Agentic** | LLM synthesis | Multi-step reasoning across audit + overlap + plan + risk. |
| Multi-intent questions | **Agentic** | LLM synthesis | Unpredictable by definition. |

#### Semi-Hardened Boundary Rules

For **semi-hardened** tasks (e.g., P/F eligibility), the LLM is allowed to add natural language context around the deterministic result, but it MUST NOT rephrase the deterministic verdict itself. The response is composed of three fixed layers:

```
┌─────────────────────────────────────────────────────────┐
│  1. DETERMINISTIC VERDICT (immutable — from tool)       │
│     "P/F grades will NOT satisfy your CS major          │
│     requirement for CSCI-UA 310."                       │
│     (This text comes from the template, never the LLM)  │
├─────────────────────────────────────────────────────────┤
│  2. FIXED CAVEAT SLOTS (from curated template)          │
│     "However, the course WILL count as free elective    │
│     credit. The FL exception does not apply here."      │
│     (Selected by template logic, not generated by LLM)  │
├─────────────────────────────────────────────────────────┤
│  3. LLM WRAPAROUND (optional natural language)          │
│     "Since you still need 4 CS electives, I'd recommend │
│     taking this course for a letter grade so it counts  │
│     toward your major."                                 │
│     (LLM adds personalized context — but cannot         │
│      contradict or restate layers 1-2)                  │
└─────────────────────────────────────────────────────────┘
```

**Rule:** The LLM can only populate Layer 3. Layers 1-2 are deterministic. The response validator checks that the final output contains the exact text from Layers 1-2 (string match, not semantic match).

**Implementation:** The orchestrator checks the tool result's `outputMode` field. If `outputMode === 'template'`, the result is formatted using a pre-written template. If `outputMode === 'semi_hardened'`, layers 1-2 are formatted from the template and the LLM is prompted to add ONLY layer 3. If `outputMode === 'synthesis'`, it goes to the LLM for full natural language generation.

```typescript
// In agentOrchestrator.ts — after tool execution, before LLM synthesis
if (toolResult.outputMode === 'template') {
  // Bypass LLM entirely. Use deterministic template.
  const response = formatTemplate(toolResult.templateId, toolResult.data);
  yield response;
  return;
}
if (toolResult.outputMode === 'semi_hardened') {
  // Layers 1-2: deterministic. Layer 3: LLM adds context.
  const fixedPart = formatTemplate(toolResult.templateId, toolResult.data);
  const llmContext = await llm.generate([
    { role: 'system', content: `The following is a verified answer. DO NOT rephrase or contradict it. Add only personalized context.` },
    { role: 'user', content: `Verified answer:\n${fixedPart}\n\nStudent profile: ${summarize(profile)}\nAdd brief personalized context:` },
  ]);
  yield fixedPart + '\n\n' + llmContext;
  return;
}
// Otherwise: full agentic synthesis.
```

### 2.5 Domain Risk Acknowledgment

> **The coding-agent paradigm does not transfer directly to compliance domains.**
>
> Claude Code's architecture works because coding mistakes are **cheap and fast to discover** (wrong code → build fails → user sees error → seconds). Academic advising mistakes are **expensive and slow to discover** (wrong plan → student takes wrong courses → discovers months later).
>
> This means the same error rate that is acceptable for a coding agent is NOT acceptable here. We compensate with: heavier logging, offline evaluation cadence (weekly), completeness checking (§9.1 Part 4c), and mandatory fallback templates for high-risk scenarios.

---

## 3. The Hybrid Architecture

### 3.1 Three Layers

```
Layer 1: DETERMINISTIC ENGINE
  What it does:   Counts, compares, filters, evaluates rules
  When it acts:   ALWAYS — every request that touches degree progress
  Trust level:    100% — results are mathematically correct
  Examples:       GPA calculation, credit counting, prereq checking

Layer 2: RAG PIPELINE  
  What it does:   Retrieves and ranks policy text from chunked documents
  When it acts:   Policy questions, uncertainty validation, advisory context
  Trust level:    Confidence-gated (0.0-1.0), with mandatory caveats below 0.6
  Examples:       "Can I P/F this course?", "What's the leave of absence process?"

Layer 3: AGENT ORCHESTRATOR
  What it does:   Decides which tools to call, in what order, handles conversation
  When it acts:   Every user message
  Trust level:    Validated — response checker catches hallucinations
  Examples:       Multi-step reasoning, data collection, result synthesis
```

### 3.2 How They Interact: Template Matcher → Agentic Loop

Every user message passes through two stages: a **pre-loop template matcher** (deterministic, no LLM) and the **agent loop** (LLM-driven, tool-calling). The template matcher intercepts the ~20-30% of queries that are FAQ-type policy questions with curated, verified answers. Everything else goes through the full agent loop.

> **Design principle:** Minimize agentic surface area. If we have a verified answer, serve it directly. Only invoke the LLM when the question genuinely requires dynamic reasoning, multi-tool coordination, or conversational context.

```
User message arrives
       │
       ▼
┌──────────────────────────────────────┐
│  STAGE 1: TEMPLATE MATCHER (§5.5)    │  No LLM, no RAG, deterministic
│                                      │
│  5-step gate (see §5.5 matching):    │
│  1. Query similarity to curated FAQ  │
│  2. Context safety (no follow-ups)   │
│  3. School match                     │
│  4. Applicability predicates         │
│  5. Freshness check                  │
│                                      │
│  All pass → serve curated answer     │──→ Return directly
│  Any fail → fall through ↓           │
└──────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│  STAGE 2: AGENT LOOP (§6.1)          │  LLM-driven, tool-calling
│  while(true) orchestrator            │  Full safety nets:
│  with all safety nets                │  invocation auditor,
│  (see below)                         │  completeness checker,
│                                      │  response validator
└──────────────────────────────────────┘
```

Inspired by Claude Code's `query.ts` architecture (a 1730-line `while(true)` generator), the agent loop is an adaptive loop where the LLM decides its next action based on what the last tool returned.

> **📖 Claude Code Reference:** `query.ts` L241-280 — the `queryLoop()` entry point creates a mutable `State` object (`messages`, `toolUseContext`, `turnCount`, `maxOutputTokensRecoveryCount`, etc.) then enters `while(true)`. Study this for the state shape we need.
>
> **📖 Claude Code Reference:** `query.ts` L1715-1728 — the loop continuation site where tool results get appended to messages and state is updated for the next iteration: `state = { messages: [...messagesForQuery, ...assistantMessages, ...toolResults], ... }`.

```typescript
// Simplified conceptual model
// Stage 1: template matcher (§5.5 — see matching logic for full 5-step gate)
// Stage 2: agent loop inspired by Claude Code's query loop
// See: §6.1 for full State type, turn limit, abort, transition tracking, and result budgeting
async function* handleMessage(message: string, profile: StudentProfile, history: Message[]) {
  // STAGE 1: Template matcher — deterministic, no LLM
  const templateMatch = matchCuratedTemplate(message, profile, history);
  if (templateMatch) {
    yield templateMatch.content;  // Serve verified answer directly
    return;
  }

  // STAGE 2: Agent loop — LLM-driven with full safety nets
  const state: State = {
    messages: [systemPrompt, ...conversationHistory, message],
    turnCount: 0,
    transition: undefined,
    abortController: new AbortController(),  // §6.2: propagated to all tool calls
    currentModel: 'gpt-4o',
    toolResultTokenEstimate: 0,
  };
  
  while (true) {
    // 0. Safety: turn-limit guard (§6.1 — prevents infinite tool-calling loops)
    if (state.turnCount >= MAX_TURNS) {
      return { reason: 'max_turns', message: 'Here\'s what I found so far...' };
    }
    
    // 0b. Safety: abort check (§6.2 — user navigated away or sent new message)
    if (state.abortController.signal.aborted) {
      return { reason: 'aborted' };
    }

    // 0c. Context management: enforce tool result budget before API call (§6.6 Tier 1)
    state.messages = enforceToolResultBudget(state.messages);
    
    // 1. LLM decides next action (call tool OR respond)
    const response = await llm.generate(state.messages, {
      tools: registeredTools,
      model: state.currentModel,
      signal: state.abortController.signal,
    });
    
    // 2. Text response → validate and return
    if (response.type === 'text') {
      const validation = responseValidator.validate(response, toolResults, profile);
      if (validation.passed) {
        yield response.content;
        return;
      }
      // Re-prompt with validation errors (transition tracking for debugging)
      state.messages.push({ role: 'system', content: validation.repromptMessage });
      state.transition = { reason: 'validation_retry', tool: 'response_validator' };
      continue;
    }
    
    // 3. Tool calls → validate inputs, execute, summarize
    for (const call of response.toolCalls) {
      const inputCheck = call.tool.validateInput(call.input, profile);
      if (!inputCheck.valid) {
        // Tool itself says "I need X first" → LLM sees this and adapts
        state.messages.push({ role: 'tool_result', content: inputCheck.message, is_error: true });
        continue;
      }
      
      const result = await call.tool.execute(call.input, {
        profile,
        abortSignal: state.abortController.signal,  // §6.2: tools can bail early
      });
      const summarized = summarizeForContext(result, call.tool.maxResultChars);
      state.messages.push({ role: 'tool_result', content: summarized });
    }
    
    // 4. Track transition reason and increment turn count
    state.transition = { reason: 'next_turn' };
    state.turnCount++;
    // Loop continues — LLM sees tool results and decides what's next
  }
}
```

**Why this is better than a rigid pipeline:**
- If the audit returns an error, the LLM asks for missing data instead of crashing
- If the plan has zero uncertainties, RAG validation is skipped automatically
- If the user only wants to know their GPA, the LLM calls one tool and responds
- New tools can be added without changing the orchestration logic

---

## 4. Deterministic Engine

> **Note:** The deterministic engine has no direct Claude Code analogue — it's our domain-specific layer. However, its **integration point** with the agent follows the Claude Code tool pattern (§6).

### 4.1 What the Engine Computes (universal, code-once)

These checks work identically for EVERY major because the logic is generic. The per-major specifics come from JSON data files.

| Check | Code Location | Input | Output |
|-------|--------------|-------|--------|
| **Rule evaluation** | `ruleEvaluator.ts` | Program JSON + completed courses | Per-rule: satisfied/remaining/partial |
| **Cross-program audit** | `crossProgramAudit.ts` | All declared programs + completed courses | Uses `SchoolConfig.doubleCounting` for per-school limits (CAS: max 2 M-M, Tisch: max 1 M-m, Stern: default 0). No triple-count. |
| **GPA calculation** | `gpaCalculator.ts` | Grades + credit hours | Cumulative, per-major, per-minor, per-concentration (Stern) |
| **Credit cap checks** | `creditCapValidator.ts` | Profile + SchoolConfig | Per-school: totalCredits, residency, non-home-school cap, advanced standing, `transferCreditLimits` |
| **Grade filtering** | `ruleEvaluator.ts` | Grades + SchoolConfig | Per-school grade thresholds (e.g., CAS: Core ≥D, Major ≥C); I/NR/W ≠ earned |
| **P/F eligibility** | `passfailGuard.ts` | Course + SchoolConfig.passFail + requirement context | Per-school: Stern allows major P/F (4 courses/yr), Tandon can't elect P/F, Tisch elective-only, Steinhardt 25% cap |
| **SPS enrollment guard** | `spsEnrollmentGuard.ts` | Course prefix + SchoolConfig.spsPolicy | Blocks Stern/Tandon; allows CAS/Tisch for specific prefixes only |
| **Prerequisite checking** | `prereqGraph.ts` | Completed courses + target course | Met/not met, missing list |
| **Enrollment validation** | `enrollmentValidator.ts` | Plan + F-1 status | Min 12 credits, max 1 online, in-person majority |
| **SAP calculation** | `academicStanding.ts` | All grades including W/NR/F | Completion rate (attempted includes W/NR/F) |
| **Graduation risk** | `graduationRisk.ts` | Remaining requirements + semesters left | Critical path, bottlenecks, pacing |
| **Exam credit resolution** | `resolveExamCredit.ts` | AP/IB scores + declared programs | Credits granted, equivalencies, revocations |
| **Priority scoring** | `priorityScorer.ts` | Eligible courses + audit result | Score each course by urgency/requirement/preference |
| **Balanced selection** | `balancedSelector.ts` | Scored courses + constraints | Final course list respecting all caps |

### 4.2 The Generic Rule Evaluator

The rule evaluator is **program-agnostic**. It doesn't know what "Computer Science" is — it just evaluates rule objects against a course list:

```typescript
function evaluateRule(rule: Rule, completedCourses: CompletedCourse[], 
                      studentStanding?: StandingLevel): RuleResult {
  // Standing gate: if rule requires minimum standing, check before evaluation
  if (rule.minStanding && !meetsStanding(studentStanding, rule.minStanding)) {
    return { satisfied: false, blocked: true, blockedReason: `Requires ${rule.minStanding} standing` }
  }

  // Filter courses to eligible grades for this context
  const eligible = completedCourses.filter(c => {
    if (rule.context === 'core') return CORE_GRADES.includes(c.grade)
    if (rule.context === 'major' || rule.context === 'minor') return MAJOR_GRADES.includes(c.grade)
    return PASSING_GRADES.includes(c.grade)
  })
  
  switch (rule.type) {
    case 'must_take':
      // For each required course, check if it OR any of its alternatives is taken
      const taken = rule.courses.filter(id => {
        if (eligible.some(c => matchesCourse(c.courseId, id))) return true
        // Check alternatives: e.g., ECON-UB 1 or ECON-UB 2
        const alts = rule.alternatives?.[id] || []
        return alts.some(alt => eligible.some(c => matchesCourse(c.courseId, alt)))
      })
      return { satisfied: taken.length === rule.courses.length, taken, remaining: diff(rule.courses, taken) }
      
    case 'choose_n':
      // Check if N courses from pool are in eligible list (supports wildcards like "CSCI-UA 4*")
      let matching = eligible.filter(c => rule.fromPool.some(p => matchesPattern(c.courseId, p)))
      // Exclude courses in excludePool
      if (rule.excludePool) matching = matching.filter(c => !rule.excludePool!.some(p => matchesPattern(c.courseId, p)))
      // Enforce minimum credits per course (e.g., Tandon "each at least 3 credits")
      if (rule.minCreditsPerCourse) matching = matching.filter(c => c.credits >= rule.minCreditsPerCourse!)
      const result: RuleResult = { satisfied: matching.length >= rule.n, taken: matching.slice(0, rule.n), remaining: rule.n - matching.length }
      // Check pool constraints (e.g., Wagner minor: "8 credits from Wagner AND 6 from Stern")
      if (rule.poolConstraints) {
        for (const pc of rule.poolConstraints) {
          const poolCredits = matching.filter(c => pc.pool.some(p => matchesPattern(c.courseId, p)))
                                      .reduce((sum, c) => sum + c.credits, 0)
          if (poolCredits < pc.minCredits) {
            result.satisfied = false
            result.poolConstraintWarnings = result.poolConstraintWarnings || []
            result.poolConstraintWarnings.push({ pool: pc.label, earned: poolCredits, required: pc.minCredits })
          }
        }
      }
      return result
      
    case 'min_credits':
      // Sum credits from matching courses
      let creditMatches = eligible.filter(c => rule.fromPool.some(p => matchesPattern(c.courseId, p)))
      if (rule.excludePool) creditMatches = creditMatches.filter(c => !rule.excludePool!.some(p => matchesPattern(c.courseId, p)))
      const credits = creditMatches.reduce((sum, c) => sum + c.credits, 0)
      return { satisfied: credits >= rule.minCredits, earned: credits, remaining: rule.minCredits - credits }
      
    case 'min_level':
      // Count courses at or above minimum level
      const atLevel = eligible.filter(c => getCourseLevel(c.courseId) >= rule.minLevel 
                                        && rule.fromPool.some(p => matchesPattern(c.courseId, p)))
      return { satisfied: atLevel.length >= rule.minCount, count: atLevel.length, remaining: rule.minCount - atLevel.length }
  }
}
```

**This single function handles CS, Economics, Psychology, History — every major.** What differs is the JSON data file that defines the rules.

### 4.3 What the Engine Does NOT Compute (deferred to RAG)

| Thing | Why Not Deterministic | How RAG Handles It |
|-------|----------------------|-------------------|
| Department-specific non-home-school course limits | Each department sets its own (0, 1, or 2). Too fluid to hardcode for 60+ depts. | Agent searches: "[dept] non-home-school course limit policy" |
| "Can I take this course online for my major?" | Department approval is per-department and per-semester. | Agent searches: "online courses [school] major [dept] department approval" |
| Petition procedures | Narrative policies, not yes/no rules. | RAG retrieves policy text about petitions, withdrawal, leave of absence |
| Course sequencing rules | Department-specific, poorly documented. | RAG searches department bulletin; if not found, advises "contact department adviser" |
| Study abroad credit transfer details | Per-program approval, not universal. | RAG retrieves study abroad policy, agent advises to contact Global Programs |
| "Should I take X or Y?" (advisory) | Value judgment, not a computation. | Agent uses audit data + RAG context to reason about tradeoffs |

### 4.4 Credit Cap Checks (deterministic, config-driven)

```typescript
// creditCapValidator.ts — reads caps from SchoolConfig, works for ALL schools

function checkCreditCaps(profile: StudentProfile, schoolConfig: SchoolConfig): CreditCapResult[] {
  const warnings: CreditCapResult[] = [];
  
  // Non-home-school cap (CAS: 16 credits, Tandon: 4 courses / 16 credits)
  const nonHomeCap = schoolConfig.creditCaps.find(c => c.type === 'non_home_school');
  if (nonHomeCap) {
    const nonHomeCredits = profile.completedCourses
      .filter(c => !schoolConfig.courseSuffix.some(s => c.courseId.includes(s)))
      .reduce((sum, c) => sum + c.credits, 0);
    if (nonHomeCredits > nonHomeCap.maxCredits * 0.75)
      warnings.push({ type: 'non_home_approaching', used: nonHomeCredits, limit: nonHomeCap.maxCredits });
    if (nonHomeCredits > nonHomeCap.maxCredits)
      warnings.push({ type: 'non_home_exceeded', used: nonHomeCredits, limit: nonHomeCap.maxCredits, severity: 'blocker' });
  }
  
  // Residency check — handles BOTH models:
  if (schoolConfig.residency.type === 'suffix_based') {
    // CAS/Tandon: count credits with specific suffix (e.g., -UA, -UY)
    const suffixCredits = profile.completedCourses
      .filter(c => c.courseId.includes(schoolConfig.residency.suffix!))
      .reduce((sum, c) => sum + c.credits, 0);
    if (suffixCredits < schoolConfig.residency.minCredits && profile.totalCredits > 96)
      warnings.push({ type: 'residency_risk', earned: suffixCredits, required: schoolConfig.residency.minCredits });
  } else if (schoolConfig.residency.type === 'total_nyu_credits') {
    // Steinhardt/Gallatin/SPS: count ANY NYU credits (not transfer)
    const nyuCredits = profile.completedCourses
      .filter(c => !c.isTransfer)
      .reduce((sum, c) => sum + c.credits, 0);
    if (nyuCredits < schoolConfig.residency.minCredits && profile.totalCredits > 96)
      warnings.push({ type: 'residency_risk', earned: nyuCredits, required: schoolConfig.residency.minCredits });
  }
  
  // All other caps (advanced_standing, pass_fail, online, transfer) from config
  for (const cap of schoolConfig.creditCaps.filter(c => c.type !== 'non_home_school')) {
    const count = countCreditsForCapType(cap.type, profile);
    if (count > cap.maxCredits)
      warnings.push({ type: `${cap.type}_exceeded`, used: count, limit: cap.maxCredits, severity: 'blocker' });
  }
  
  return warnings;
}
```

### 4.5 Cross-Program Substitutions

When a student has multiple programs (double major, major + minor), **conditional substitutions** can apply: a course from one major may waive a requirement from another, but typically with a replacement obligation.

> **Example:** A CS/Math double major takes MATH-UA 252 (Numerical Analysis). This waives CSCI-UA 421 (Numerical Computing) from the CS side, but the student must replace it with another 400-level CS course.

This is NOT handled by cross-listings (they're different courses), NOT by `conditionalExemption` (which only checks declared programs, not completed courses), and NOT by double-counting (which shares one course across two requirements). It's a **three-part rule:** cross-program condition → course-level waiver → replacement obligation.

#### Schema Extension: `substitutions` Field

The `substitutions` field is added to any rule in the program JSON. No new rule type needed:

```json
// In cas_cs_ba.json
{
  "ruleId": "cs_numerical",
  "type": "must_take",
  "label": "Numerical Computing",
  "courses": ["CSCI-UA 421"],
  "substitutions": [
    {
      "original": "CSCI-UA 421",
      "substituteWith": "MATH-UA 252",
      "condition": {
        "type": "has_program_and_course",
        "program": "cas_math_ba",
        "course": "MATH-UA 252"
      },
      "replacement": {
        "type": "choose_n",
        "n": 1,
        "fromPool": ["CSCI-UA 4*"],
        "minLevel": 400,
        "label": "CS elective replacing Numerical Computing (Math substitution)"
      }
    }
  ]
}
```

#### Substitution Condition Types

```typescript
type SubstitutionCondition =
  | { type: "has_program"; program: string }                // Student declared this program
  | { type: "has_course"; course: string }                   // Student completed this course
  | { type: "has_program_and_course";                        // Both conditions
      program: string; course: string }
  | { type: "needs_department_approval" }                    // Flag for manual review
```

#### Evaluator Logic (~30 lines added to `ruleEvaluator.ts`)

```typescript
// In evaluateRule(), before the standard switch(rule.type) logic:

if (rule.substitutions) {
  for (const sub of rule.substitutions) {
    const conditionMet = evaluateSubstitutionCondition(
      sub.condition, declaredPrograms, completedCourses
    );

    if (conditionMet && isInSet(sub.substituteWith, completedCourses)) {
      // Original course is waived — student has the substitute
      // Replacement rule is INJECTED into the active rule set
      return {
        ruleId: rule.ruleId,
        status: "satisfied",
        coursesSatisfying: [sub.substituteWith],
        remaining: 0,
        substitutionApplied: {
          original: sub.original,
          satisfiedBy: sub.substituteWith,
          reason: `${sub.substituteWith} from ${sub.condition.program} substitutes for ${sub.original}`,
          replacementRule: sub.replacement,  // crossProgramAudit collects this
        }
      };
    }
  }
  // If no substitution matched, fall through to normal evaluation
}
```

The `crossProgramAudit.ts` (Phase 1) collects all `substitutionApplied.replacementRule` entries from per-program audits and adds them to the active rule set. The generic evaluator then evaluates the replacement rules like any other rule — no special-case code per major.

#### Real Cross-Program Patterns at NYU

| Pattern | Example | Condition Type | Replacement? |
|---------|---------|---------------|-------------|
| Content overlap substitution | CS/Math: Numerical Analysis ↔ Numerical Computing | `has_program_and_course` | Yes (same-level CS course) |
| Shared foundation exemption | CS/Econ: Both require Calc I. If Econ's calc sequence taken, CS exempts. | `has_program_and_course` | No (just waived) |
| Minor-into-major absorption | Math minor → Math major: minor courses roll into major | `has_program` | No (skip minor audit entirely) |
| Cross-school equivalent | Stern Stat ↔ CAS Stat: different IDs, same content | `needs_department_approval` | No, but flagged for manual review |

All patterns use the same `substitutions` schema. **Zero per-major code.**

---

## 5. RAG Pipeline

### 5.1 Architecture

```
User question (or agent uncertainty query)
       │
       ▼
┌─────────────────────────┐
│  1. EMBEDDING MODEL      │    OpenAI text-embedding-3-small
│     Question → vector    │    1536 dimensions
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  2. SCOPE FILTER (hard)  │    Applied BEFORE vector search
│                          │
│  a. Year freshness:      │    Hard-filter out chunks where
│     chunk.year < current │    year < current catalog year.
│     catalog year         │    Stale policies are the most
│                          │    dangerous retrieval error.
│                          │
│  b. School filter:       │    DEFAULT-HARD to homeSchool + "all"
│     Default: chunk.school│    (NYU-wide chunks always included).
│     ∈ {homeSchool, "all"}│
│                          │    EXPLICIT OVERRIDE: if the search
│     Override: if query   │    query contains an explicit school
│     contains non-home    │    name (e.g., "Stern", "Tandon"),
│     school name →        │    include that school's chunks too.
│     include that school  │
│                          │    WHY default-hard, not soft:
│                          │    We don't trust the LLM to always
│                          │    reformulate context-dependent
│                          │    references (e.g., "there") into
│                          │    explicit school names. Hard filter
│                          │    prevents cross-school contamination.
│                          │    Explicit school names in the query
│                          │    are a deterministic, safe signal.
│                          │
│     NOTE: V1 matches      │    Future enhancement: expand to
│     literal school names  │    aliases ("business school" → Stern,
│     only ("Stern",        │    "engineering" → Tandon, etc.)
│     "Tandon", etc.)       │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  3. VECTOR SEARCH        │    Cosine similarity
│     Top-K = 20 chunks    │    From scoped policy docs
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  4. COHERE RERANK v3.5   │    Cross-encoder reranking
│     Re-score all 20      │    Returns relevance scores 0.0-1.0
│     Keep top 3-5         │    Much more accurate than embedding-only
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  5. CONFIDENCE GATING    │
│     ≥ 0.6: cite directly │
│     0.3-0.6: cite + warn │
│     < 0.3: escalate      │
└────────┬────────────────┘
         │
         ▼
   { chunks, confidence, sources }
```

### 5.2 Why Cohere Rerank

Embedding-only retrieval has a fundamental weakness: **cosine similarity measures topical similarity, not answer quality.** A chunk about "P/F grading for transfer students" and one about "P/F grading for CAS majors" will have similar embeddings, but only one answers the question.

Cohere Rerank v3.5 is a cross-encoder that scores each (query, chunk) pair for **actual relevance**, not just topical similarity. This improves precision from ~70% to ~92% in our testing.

### 5.3 Policy Document Chunking Strategy

```
Source documents (per school — each school's bulletin is chunked separately):
  - Per-school academic policies (CAS: ~80 chunks, Stern: ~60, Tandon: ~50, etc.)
  - Per-school core/shared requirements (CAS Core, Tandon HUSS, Stern business core, etc.)
  - Per-department bulletins (scraped, ~20-50 chunks each)
  - NYU-wide transfer credit policies (~30 chunks)
  - NYU-wide F-1/visa policies (~20 chunks)
  - Per-school admissions/internal-transfer policies (~15 chunks each)

Chunking rules:
  - Split on section headings (§ markers)
  - Max 500 tokens per chunk
  - 50-token overlap between adjacent chunks
  - Each chunk tagged with: source document, school, section name, year
  
Metadata per chunk:
  { source: "CAS Academic Policies", school: "cas", section: "Pass/Fail Option", 
    year: "2024-2025", chunkId: "cas_pf_003" }
  { source: "Stern Academic Policies", school: "stern", section: "Credit Overload",
    year: "2024-2025", chunkId: "stern_overload_001" }
```

### 5.4 When the Agent Calls RAG

The agent calls `search_policy` in three scenarios:

1. **User asks a policy question directly:** "Can I take more than 18 credits?"
2. **Planner flags an uncertainty:** Online course for major → agent RAG-checks the policy
3. **Agent needs clarification on a rule:** "Does the CS department allow non-home-school electives?"

The agent does NOT call RAG for:
- GPA, credits, or any number → deterministic tools
- "What courses do I need?" → `run_full_audit`
- "Plan my semester" → `plan_semester`
- "Can I transfer to Stern?" → `check_transfer_eligibility`
- "What if I switched to Econ?" → `what_if_audit`
- "I'm undeclared, what should I take?" → `run_full_audit` (school_only mode) → `plan_semester`

### 5.5 Curated Policy Templates (High-Frequency FAQ)

> **Problem:** Without curated answers, the same policy question asked twice may produce inconsistent wording — not because the policy changed, but because the LLM synthesized the same chunk differently. Students lose trust when "P/F is not allowed for major courses" becomes "P/F won't satisfy your major requirement" across sessions.
>
> **Solution:** For the top 20-30 most commonly asked policy questions, maintain human-curated stable answer templates. These are checked BEFORE RAG synthesis. If a match is found, the curated answer is used directly (no LLM synthesis). If no match, fall through to standard RAG + synthesis.

```
packages/engine/src/data/policyTemplates/
  ├── pf_major.md           "Can I P/F a course in my major?"
  ├── pf_minor.md           "Can I P/F a course in my minor?"
  ├── credit_overload.md    "Can I take more than 18 credits?"
  ├── f1_fulltime.md        "What counts as full-time for F-1?"
  ├── online_limits.md      "How many online courses can I take?"
  ├── double_count.md       "Can a course count for two majors?"
  ├── transfer_credits.md   "How do transfer credits work?"
  ├── withdraw_deadline.md  "When can I withdraw from a course?"
  ├── grade_replace.md      "Can I retake a course to replace the grade?"
  ├── latin_honors.md       "How are Latin honors determined?"
  └── ... (20-30 total)
```

Each template follows a standard format:

```markdown
---
triggerQueries:       # Queries that should match this template
  - "Can I P/F a major course"
  - "pass fail major"
  - "P/F for my major"
source: "CAS Academic Policies, §Pass/Fail Option"
school: "cas"  # Template applies to this school (or "all" for NYU-wide)
lastVerified: "2025-04-15"
applicability:        # Optional — only needed for templates with known cross-school conflicts
  excludeIfPrograms:  # Don't use this template if student has programs in these schools
    - "stern"         # Stern has different P/F rules (4 courses/yr, major P/F allowed)
  requiresNoTransferIntent: true  # Don't use if student is exploring transfer
---

**Short answer:** P/F grades are accepted but will not satisfy major or minor
requirements. You may still take the course P/F; it will count as free elective
credit only.

**Details:** [Full curated explanation with conditions and exceptions]

**Important:** If the course is an early foreign language course (not used for
the FL requirement), the P/F restriction does not apply (CAS Policy §FL Exception).

**Note:** P/F policies vary by school. This template is for CAS students.
For Stern, Tandon, or other schools, the agent falls through to RAG search.
```

> **Applicability predicates:** Only the 5-6 templates with known cross-school conflicts (P/F, double-counting, credit caps, overload, transfer credits) need `applicability` rules. The remaining 20+ templates are school-scoped and the school check alone is sufficient.

**Matching logic (5-step gate before entering the agent loop):**

```
Template Matcher (runs before agent loop for every user message)

1. QUERY SIMILARITY: Check user query against triggerQueries
   via embedding similarity (≥ 0.85) or keyword match.
   → No match → skip to agent loop.

2. CONTEXT SAFETY: If conversation history has > 2 messages,
   check if query contains context-dependent references:
   "that", "those", "it", "there", "the one", "we discussed",
   "the plan", "those courses", etc.
   → If context-dependent → skip to agent loop.
   (The query might look like a FAQ but actually references
   prior conversation context that the template can't see.)

3. SCHOOL CHECK: template.school === profile.homeSchool
   OR template.school === "all"
   → School mismatch → skip to agent loop.
   (The same question has different answers per school.)

4. APPLICABILITY CHECK (if template has applicability field):
   - excludeIfPrograms: any of student's declared programs in a listed school?
   - requiresNoTransferIntent: student has transferIntent in profile?
   → If excluded → skip to agent loop.
   (Cross-school program combinations may invalidate the template.)

5. FRESHNESS CHECK: template.lastVerified is within current
   academic year (or within 12 months).
   → If stale → skip to agent loop + flag for maintenance.

All 5 pass → serve curated template, BUT first run a lightweight post-check:

POST-CHECK (after gate passes, before returning):
  - Verify template.id is logged (for audit trail)
  - Verify template.source is a valid, known document
  - Verify the served content references the correct school name
  If post-check fails → fall through to agent loop (silent template corruption).
  This keeps the direct path cheap but prevents silent failures.

Any gate fails → Fall through to agent loop (§6.1).
```

> **Why not skip the agent loop for more queries?** Accuracy > latency. The template matcher only handles queries where we have a *verified, school-appropriate, context-independent* answer. Everything else goes through the full agent loop with all safety nets (invocation auditor, completeness checker, response validator).

**Maintenance:** Templates are reviewed quarterly against the NYU Bulletin. Each has a `lastVerified` date. Templates that fail the freshness check are flagged for review but still fall through to RAG (never served stale).

---

## 6. Agent Orchestrator (The Loop)

### 6.1 Design (inspired by Claude Code `query.ts`)

The orchestrator is modeled after Claude Code's proven `while(true)` agentic loop architecture. Key principles borrowed:

> **📖 Claude Code Reference — what to study before implementing:**
> 1. `query.ts` L241-280 — **State initialization** (`State` type, `queryLoop()` entry). Understand the mutable state shape.
> 2. `query.ts` L307-340 — **Loop top** (`while(true)`, destructure state, start prefetch). This is where each iteration begins.
> 3. `query.ts` L659-708 — **Model call** (`callModel()` with tools, system prompt, model config). How tools are passed to the LLM.
> 4. `query.ts` L826-863 — **Tool detection** (checking for `tool_use` blocks, setting `needsFollowUp = true`).
> 5. `query.ts` L1062-1357 — **Non-tool-use exit** (stop hooks, response validation, error recovery cascade).
> 6. `query.ts` L1380-1408 — **Tool execution** (`runTools()` or `StreamingToolExecutor`). Tools execute and results collected.
> 7. `query.ts` L1715-1728 — **Loop continuation** (append assistant messages + tool results → update State → `continue`).
> 8. `query/deps.ts` L21-40 — **Dependency injection** (`QueryDeps` type). We adopt this pattern for testability.

| Claude Code Pattern | Our Implementation |
|---|---|
| `while(true)` with `needsFollowUp` flag | Same — loop until LLM produces text-only response |
| `validateInput()` per tool | Each tool validates its own preconditions |
| `maxResultSizeChars` per tool | Tool results summarized if > threshold |
| `ToolResult<T>` envelope | Success = return data; failure = throw → loop handles |
| `buildTool()` factory with safe defaults | All tools go through factory; `isReadOnly` defaults to `false` |
| Dynamic `prompt()` method | Tool descriptions adapt to student's declared programs |
| Dependency injection (`QueryDeps`) | Tools injected, not imported — enables testing |
| Error cascade (fallback → retry → escalate) | Multi-layer recovery before surfacing error |
| `maxTurns` turn-limit guard (`query.ts L1704-1711`) | Same — exit after `MAX_TURNS` (8) to prevent infinite tool-calling loops |
| `abortController` propagation (`Tool.ts L180`) | Same — `AbortSignal` in ToolContext; tools bail early on abort |
| `transition` reason tracking (`query.ts L216`) | Same — `State.transition` records why each iteration continued, prevents infinite recovery loops |
| `applyToolResultBudget()` (`query.ts L379-394`) | Same — aggregate token budget across all tool results in messages[], oldest results get summarized |
| Model fallback on 429/503 (`query.ts L893-953`) | Same — GPT-4o → GPT-4o-mini fallback chain with user notification |

#### Orchestrator State Type

> **📖 Claude Code Reference:** `query.ts` L204-217 — the mutable `State` type carried between loop iterations. We adopt a simplified version with the same key fields: `messages`, `turnCount`, `transition`.

```typescript
// agentOrchestrator.ts — mutable state between loop iterations
// Modeled after query.ts L204-217 State type

type Transition =
  | { reason: 'next_turn' }
  | { reason: 'stop_hook_retry'; error: string }
  | { reason: 'validation_retry'; tool: string }
  | { reason: 'error_recovery'; attempt: number }
  | { reason: 'model_fallback'; from: string; to: string };

type State = {
  messages: Message[];
  turnCount: number;              // Incremented after each tool execution batch
  transition?: Transition;        // Why the previous iteration continued (debuggability + loop prevention)
  abortController: AbortController;     // Propagated to all tool calls
  currentModel: string;                 // GPT-4o by default, falls back to GPT-4o-mini
  toolResultTokenEstimate: number;      // Running sum of all tool_result tokens in messages[]
};

const MAX_TURNS = 8;   // Academic advising rarely needs >5 tool calls
const MAX_TOOL_RESULT_BUDGET = 8000; // Max aggregate tool_result tokens before compaction
```

#### Turn-Limit Guard

> **📖 Claude Code Reference:** `query.ts` L1704-1711 — if `nextTurnCount > maxTurns`, yield `max_turns_reached` and exit. Prevents infinite tool-calling loops from burning unlimited API tokens.

```typescript
// In the main loop, after tool results are collected and appended:
state.turnCount++;
if (state.turnCount >= MAX_TURNS) {
  // Force the LLM to summarize what it has so far instead of calling more tools
  return {
    reason: 'max_turns',
    message: 'I\'ve gathered all the information I can in this turn. Here\'s what I found...'
  };
}
```

#### Tool Result Budget Enforcement

> **📖 Claude Code Reference:** `query.ts` L379-394 — `applyToolResultBudget()` runs before every API call. When aggregate tool results exceed the budget, largest results are replaced with their `summarizeResult()` output.

```typescript
// Before each API call in the loop:
function enforceToolResultBudget(messages: Message[]): Message[] {
  const toolResults = messages.filter(m => m.role === 'tool_result');
  const totalTokens = toolResults.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  if (totalTokens <= MAX_TOOL_RESULT_BUDGET) return messages;

  // Sort by size descending, keep most recent 2 full, summarize the rest
  const sorted = [...toolResults].sort((a, b) => estimateTokens(b.content) - estimateTokens(a.content));
  const toSummarize = sorted.slice(0, -2); // Preserve 2 most recent
  const summarizedIds = new Set(toSummarize.map(m => m.toolUseId));

  return messages.map(m =>
    m.role === 'tool_result' && summarizedIds.has(m.toolUseId)
      ? { ...m, content: m.tool.summarizeResult(m.fullResult) }
      : m
  );
}
```

### 6.2 Tool Interface (inspired by Claude Code `Tool.ts`)

> **📖 Claude Code Reference — the full `Tool` type:**
> - `Tool.ts` L362-466 — The complete `Tool<Input, Output, P>` type with ~30 methods.
> - `Tool.ts` L489-492 — `validateInput()` signature: `validateInput?(input, context): Promise<ValidationResult>`.
> - `Tool.ts` L518-523 — `prompt()` signature: takes `options` with tools and agents, returns `Promise<string>`.
> - `Tool.ts` L321-336 — `ToolResult<T>` type: `{ data: T, newMessages?, contextModifier? }`.
> - `Tool.ts` L402 — `isConcurrencySafe(input)`: determines if this tool can run in parallel.
> - `Tool.ts` L404 — `isReadOnly(input)`: drives the concurrent/serial partitioning in `toolOrchestration.ts`.
> - `Tool.ts` L457-466 — `maxResultSizeChars`: hard cap on result size before it gets persisted to disk.
>
> We adopt a **simplified subset** (8 methods vs their ~30) since we don't need CLI rendering, permission dialogs, or MCP integration.

```typescript
import { z } from 'zod';

// Adapted from Claude Code Tool.ts L362-466 (simplified for our domain)
interface AgentTool<Input extends z.ZodObject, Output> {
  name: string;
  
  // Schema — validated automatically before call()
  inputSchema: Input;
  outputSchema?: z.ZodType<Output>;
  
  // Self-description — used in system prompt, adapts to context
  prompt(profile: StudentProfile): string;
  
  // Pre-execution validation — tool checks its own preconditions
  // If invalid, returns message that the LLM sees and adapts to
  validateInput(input: z.infer<Input>, profile: StudentProfile): ValidationResult;
  
  // Execution
  call(input: z.infer<Input>, context: ToolContext): Promise<Output>;
  
  // Safety metadata
  isReadOnly: boolean;            // Can run in parallel with other read-only tools
  maxResultChars: number;         // Result gets summarized if exceeds this
  
  // Context summarization — converts full result to LLM-friendly summary
  summarizeResult(result: Output): string;
}

type ValidationResult = 
  | { valid: true }
  | { valid: false; message: string }  // LLM sees this message

// Context passed to every tool call
// 📖 Claude Code Reference: Tool.ts L158-300 — ToolUseContext carries abort controllers,
// state getters/setters, options, and tracking through every tool call. Our version is simplified.
type ToolContext = {
  profile: StudentProfile;
  schoolConfig: SchoolConfig;
  programConfigs: ProgramConfig[];
  abortSignal: AbortSignal;       // From State.abortController — tools check this before expensive ops
  // Usage in tools:
  //   if (ctx.abortSignal.aborted) return { aborted: true };
  //   // ... expensive DB read or computation
};

// Factory with safe defaults
// 📖 Claude Code Reference: Tool.ts L757-792 — TOOL_DEFAULTS and buildTool()
// Their defaults: isEnabled→true, isConcurrencySafe→false, isReadOnly→false,
// isDestructive→false, checkPermissions→allow. Fail-closed where it matters.
// The spread `{ ...TOOL_DEFAULTS, ...def }` ensures callers never need `?.() ?? default`.
function buildTool<I extends z.ZodObject, O>(def: Partial<AgentTool<I, O>>): AgentTool<I, O> {
  return {
    isReadOnly: false,                    // Assume writes — override if read-only
    maxResultChars: 2000,                 // Default context budget per tool
    summarizeResult: (r) => JSON.stringify(r).substring(0, 2000),
    ...def,
  } as AgentTool<I, O>;
}
```

### 6.3 Tool Concurrency (inspired by Claude Code `toolOrchestration.ts`)

> **📖 Claude Code Reference:** `services/tools/toolOrchestration.ts` L91-116 — `partitionToolCalls()` groups consecutive concurrency-safe tools into **batches** that run in parallel, while non-safe tools run serially. The key function:
> ```typescript
> // From toolOrchestration.ts L91-116
> function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
>   // For each tool, check isConcurrencySafe(parsedInput)
>   // Group consecutive safe tools into one batch
>   // Each non-safe tool becomes its own batch
> }
> ```
>
> **Our application:** All our deterministic tools (`run_full_audit`, `get_credit_caps`, `get_academic_standing`) are read-only and concurrency-safe. If the LLM calls `run_full_audit` + `get_credit_caps` in the same turn, they run in parallel. `plan_semester` is NOT concurrency-safe because it depends on the audit result. `update_profile` is NEVER concurrent — it's a synchronous, confirmed mutation that must complete before any other tool runs.

### 6.4 Error Recovery Cascade (inspired by Claude Code's multi-layer recovery)

> **📖 Claude Code Reference:** `query.ts` L1062-1357 — the entire non-tool-use exit path. Study the cascade:
> 1. L1070-1117: prompt-too-long recovery (context collapse → reactive compact → surface)
> 2. L1188-1256: max_output_tokens recovery (escalate to 64k → inject "resume" message → retry 3x → give up)
> 3. L893-953: model fallback (switch to fallback model on FallbackTriggeredError)
> 4. L1267-1306: stop hook blocking errors (re-prompt with error context)
>
> **Pattern:** Each recovery is a `state = { ...newState }; continue` that restarts the loop. Recovery attempts are tracked (`maxOutputTokensRecoveryCount`, `hasAttemptedReactiveCompact`) to prevent infinite loops.

```
Tool call fails
  │
  ├─ Is it a validation error? (bad input)
  │   → Return error message to LLM
  │   → LLM adapts (asks user for data, tries different tool)
  │
  ├─ Is it a "tool_unsupported" error? (program not in system)
  │   → Return structured message: "Program X not in system"
  │   → LLM tells student: "I don't have data for X yet. Contact your school's advising office."
  │   → Log to fallback_log.jsonl for monitoring
  │
  ├─ Is it a transient error? (API timeout, DB error)
  │   → Retry once
  │   → If still fails: "I ran into a technical issue. Try again in a moment."
  │   → Log to error tracking
  │
  └─ Is it an unknown error?
      → "I encountered an unexpected issue computing [X]."
      → Provide specific NYU contact info
      → Log full error for debugging
```

### 6.5 Model Selection

> **Primary agent model: GPT-4o.** The v3.1 architecture was specifically designed so the LLM's job is narrow: pick the right tools, then summarize deterministic results in natural language. Safety nets (validators, invocation auditing, completeness checks) compensate for model imperfections.

| Role | Model | Why |
|------|-------|-----|
| **Agent loop** (tool selection + synthesis) | GPT-4o | Fast (~500ms), excellent function calling, cost-effective ($2.50/$10 per 1M tokens). The architecture's safety nets compensate for reasoning gaps. |
| **Semi-hardened Layer 3** (wraparound text) | GPT-4o | Simple task: add context without contradicting Layers 1-2. Validator enforces string match on deterministic layers. |
| **Eval judge** (Appendix D scoring) | GPT-4.1 / Claude 3.5 Sonnet | Offline batch evaluation (~200 cases/week). Accuracy matters more than speed. Cost negligible at this scale. |

**Why NOT a stronger model for the agent loop:**

1. **Hardened paths bypass the LLM entirely.** F-1 compliance, credit counts, audit summaries, SAP — all template-formatted. The LLM never touches them.
2. **Tool calling is GPT-4o's strongest capability.** And that's the primary LLM task.
3. **Latency matters for chat UX.** Students won't wait 3-5 seconds. GPT-4o's ~500ms response time is a real advantage.
4. **Diminishing returns.** The claim-to-tool contract blocks responses that skip tools regardless of model. The completeness checker catches omissions regardless of model. A stronger model would marginally improve agentic synthesis quality, but the highest-risk outputs are already deterministic.

**When to upgrade — watch these eval metrics:**

| Metric | Threshold | If Exceeded → |
|--------|-----------|--------------|
| Tool selection error rate | > 5% | LLM calling wrong tool or skipping required tools despite system prompt → consider GPT-4.1 |
| Layer 3 contradiction rate | > 2% | Semi-hardened wraparound contradicts deterministic layers → tighten prompt first, then consider upgrade |
| Multi-intent decomposition miss | > 10% | User asks 3 things, LLM only addresses 2 → consider upgrade |
| Eval composite score (Appendix D) | < 0.85 | Overall correctness below threshold → diagnose which dimension is failing before upgrading |

> **Note:** Always tighten system prompt and validator rules BEFORE upgrading the model. A model upgrade is the most expensive lever — exhaust structural fixes first.

#### Model Fallback Cascade

> **📖 Claude Code Reference:** `query.ts` L893-953 — on `FallbackTriggeredError` (rate limit, high demand), the loop switches to `fallbackModel`, clears orphaned tool results, and retries. User sees: "Switched to [fallback] due to high demand."

```
Model Fallback Chain:
1. GPT-4o (primary) — 500ms, best function calling
2. GPT-4o-mini (fallback) — 200ms, adequate for tool selection + synthesis
3. Graceful error message if both fail

On API error (429 rate limit, 503 model unavailable):
  - Set state.currentModel = fallbackModel
  - Set state.transition = { reason: 'model_fallback', from: 'gpt-4o', to: 'gpt-4o-mini' }
  - Log: "model_fallback_triggered"
  - System message to user: "I'm using a faster backup model right now."
  - Continue the loop (retry same request with fallback model)
  - If fallback also fails → "I'm having trouble connecting. Please try again in a moment."
```

### 6.6 Context Management (Within-Session)

> **📖 Claude Code Reference:** `query.ts` L454-543 — `autoCompactIfNeeded()` runs every iteration, forking a lightweight LLM call to summarize history when approaching the context window limit. Additional strategies: reactive compact (on 413 error), microcompact (stale tool result removal), snip compact (message pruning), context collapse (staged summarization).
>
> We adopt a simplified 3-tier strategy appropriate for our domain (advising sessions are typically <20 turns, but "what if" scenarios can generate large audit payloads).

```
TIER 1 — Tool Result Compaction (automatic, cheap, runs every turn):
  After each tool execution batch:
  1. Count aggregate tool_result tokens in messages[]
  2. If sum > MAX_TOOL_RESULT_BUDGET (8000 tokens):
     - Keep the 2 most recent tool_results at full fidelity
     - Replace older tool_results with summarizeResult() output
     - This reuses the summarizeResult() method every tool already defines
  Rationale: A full audit result (~2000 tokens) from 3 turns ago is
  unlikely to need full detail — the summary suffices for context.

TIER 2 — Conversation Summarization (expensive, last resort):
  When estimated context tokens > 80% of model's context window:
  1. Fork a cheap model call (GPT-4o-mini) with prompt:
     "Summarize this academic advising conversation. Preserve: student name,
      school, declared programs, key decisions made, open questions."
  2. Replace all messages before the summary with a single system message:
     "Previous conversation summary: [summary]"
  3. Continue the loop with compacted messages
  4. Log: "session_compacted" with pre/post token counts

TIER 3 — Graceful Termination (safety net):
  When estimated context tokens > 95% of model's context window:
  1. Finalize the current response
  2. Message: "We've covered a lot! To keep things accurate, I recommend
     starting a fresh session. Everything we discussed is saved."
  3. Persist session summary via sessionSummaries[] (§7.3)
  4. Return { reason: 'context_limit' }
```

> **Cross-session vs within-session:** §7.3 handles session summaries for *resumption across sessions* (rolling window of 5 summaries). This section handles *within a single session* where the context window fills up during extended advising conversations.

---

## 7. Tool Definitions

> **📖 Claude Code Reference for implementing each tool:**
> - Study ANY tool in `tools/` directory for the pattern: `XxxTool.ts` exports a tool built with `buildTool()`, with separate `prompt.ts` for the system prompt description.
> - Example structure: `tools/FileReadTool/FileReadTool.ts` (tool definition), `tools/FileReadTool/prompt.ts` (LLM-facing description).
> - `tools/AgentTool/prompt.ts` L66-113 — Study the "Writing the prompt" and "When to fork" sections for how to write self-contained tool descriptions that prevent the LLM from misusing tools.

### 7.1 Complete Tool Registry

| Tool | Type | ReadOnly | MaxResultChars | When Agent Uses It |
|------|------|----------|----------------|-------------------|
| `run_full_audit` | Deterministic | ✅ | 3000 | Any question about degree progress, remaining requirements |
| `plan_semester` | Deterministic | ✅ | 2500 | "Plan my next semester", "What should I take?" |
| `search_policy` | RAG | ✅ | 1500 | Policy questions, uncertainty validation |
| `search_courses` | Hybrid | ✅ | 2000 | "What electives are available?", "Find courses about X" |
| `check_overlap` | Deterministic | ✅ | 1000 | Double major/minor course sharing questions |
| `get_credit_caps` | Deterministic | ✅ | 800 | Credit count questions, P/F eligibility |
| `get_academic_standing` | Deterministic | ✅ | 600 | GPA, SAP, standing status |
| `get_enrollment_status` | Deterministic | ✅ | 600 | F-1 constraints, credit load validation |
| `check_transfer_eligibility` | Deterministic | ✅ | 1500 | "Can I transfer to Stern?", "Am I eligible?" |
| `what_if_audit` | Deterministic | ✅ | 2500 | "What if I switch to Econ?", "Compare CS vs Math" |
| `update_profile` | **Write** | ❌ | 1000 | Student corrects/adds info: "I actually don't have AP Calc", "I declared a minor" |
| `confirm_profile_update` | **Write** | ❌ | 500 | Student confirms a pending profile mutation after seeing the preview |

### 7.2 Tool Definitions with `validateInput()` and `prompt()` 

> **📖 Claude Code Reference:** `Tool.ts` L489-492 — `validateInput()` is called BEFORE `checkPermissions()` and BEFORE `call()`. It returns `{ result: true }` or `{ result: false, message, errorCode }`. The error message goes directly into the tool_result as `is_error: true`, so the LLM sees it and can adapt.
>
> **📖 Claude Code Reference:** `Tool.ts` L95-101 — `ValidationResult` type:
> ```typescript
> type ValidationResult = { result: true } | { result: false; message: string; errorCode: number }
> ```

#### `run_full_audit`

```typescript
const runFullAudit = buildTool({
  name: 'run_full_audit',
  isReadOnly: true,
  maxResultChars: 3000,
  
  inputSchema: z.object({
    programFilter: z.string().optional(), // Filter to specific program
  }),
  
  validateInput(input, profile) {
    // Undeclared students: if homeSchool is set, run school-level-only audit
    // (Core progress, credit caps, residency — no major-specific rules)
    if (!profile.declaredPrograms?.length && !profile.homeSchool) {
      return { valid: false, message: "Need at minimum your school. Ask: 'What school are you in? (CAS, Tandon, Stern, etc.) And what is your major, if you have declared one?'" }
    }
    if (!profile.completedCourses?.length) {
      return { valid: false, message: "No transcript data. Ask: 'Please upload your transcript so I can see what you've completed.'" }
    }
    // Determine audit mode based on program declarations
    const mode = !profile.declaredPrograms?.length ? 'school_only'
      : profile.declaredPrograms.every(p => p.status === 'exploring') ? 'exploratory'
      : 'full'
    return { valid: true, mode }
  },
  
  prompt(profile) {
    const programs = profile.declaredPrograms?.map(p => `${p.name} (${p.status})`).join(', ')
    const school = profile.homeSchool || 'unknown'
    if (!programs) {
      return `Run a school-level audit for ${school} (student is undeclared). ` +
        `Returns: Core/shared requirement progress, credit caps, residency status, GPA. ` +
        `No major-specific rules are checked. Useful for undeclared freshmen.`
    }
    return `Run a comprehensive degree audit for the student's programs (${programs}). ` +
      `Returns: per-program rule status, GPA, credit counts, warnings, and risks. ` +
      `For 'exploring' programs, shows requirements informally (not as hard obligations). ` +
      `ALWAYS call this before plan_semester. Call when student asks about progress, remaining requirements, or graduation.`
  },
  
  summarizeResult(result) {
    return `Audit: ${result.remainingTotal} requirements remaining across ${result.programs.length} programs. ` +
      `Credits: ${result.earnedCredits}/${result.requiredCredits}. GPA: ${result.cumulativeGPA}. ` +
      `Warnings: ${result.warnings.length}. Risks: ${result.risks.length}.`
  },
})
```

#### `plan_semester`

```typescript
const planSemester = buildTool({
  name: 'plan_semester',
  isReadOnly: true,
  maxResultChars: 2500,
  
  inputSchema: z.object({
    term: z.enum(['fall', 'spring', 'summer']),
    year: z.number(),
    auditResult: z.any(),          // From run_full_audit
    maxCredits: z.number().default(16),
  }),
  
  validateInput(input, profile) {
    if (!input.auditResult) {
      return { valid: false, message: "Must run run_full_audit first to determine remaining requirements." }
    }
    if (!profile.targetGraduationTerm) {
      return { valid: false, message: "Target graduation unknown. Ask: 'When are you planning to graduate?'" }
    }
    // For undeclared students: plan Core + exploring-major prereqs
    // For students with 'intended' transfer targets: prioritize transfer prereqs
    return { valid: true }
  },
  
  prompt(profile) {
    const visa = profile.visaStatus === 'F-1' ? ' F-1 constraints enforced.' : ''
    return `Generate a semester course plan.${visa} ` +
      `Returns: recommended courses with reasons, credit total, risks, and uncertainties that need policy validation. ` +
      `ALWAYS run run_full_audit before this tool. Call when student asks about next semester or course recommendations.`
  },
  
  summarizeResult(result) {
    const courses = result.courses.map(c => `${c.id} (${c.reason})`).join('; ')
    return `Plan: ${courses}. Total: ${result.totalCredits} credits. ` +
      `Uncertainties: ${result.uncertainties.length}. Risks: ${result.risks.length}.`
  },
})
```

#### `search_policy`

```typescript
const searchPolicy = buildTool({
  name: 'search_policy',
  isReadOnly: true,
  maxResultChars: 1500,
  
  inputSchema: z.object({
    query: z.string().describe('Natural language policy question'),
  }),
  
  // Output type — enriched beyond raw chunk retrieval
  // Connects to curated templates (§5.5) and provides structured metadata
  // so the agent and validator can reason about answer quality.
  outputSchema: z.object({
    confidence: z.number(),             // Rerank score 0.0-1.0
    answerable: z.enum(['yes', 'partial', 'no']),  // Can this query be answered from available sources?
    matchedTemplateId: z.string().nullable(),       // If matched a curated FAQ template (§5.5)
    topChunk: z.object({
      text: z.string(),
      source: z.string(),
      section: z.string(),
    }),
    applicabilityNotes: z.string().nullable(),      // Conditions/exceptions that affect this answer
    needsAdviserConfirmation: z.boolean(),           // True if policy requires "with adviser approval"
    relatedChunksCount: z.number(),                  // How many other chunks were relevant (context)
  }),
  
  validateInput(input) {
    if (input.query.length < 5) {
      return { valid: false, message: "Query too short. Provide a specific policy question." }
    }
    return { valid: true }
  },
  
  prompt() {
    return `Search NYU policy documents for answers to policy questions. ` +
      `Automatically filters by the student's home school (${profile?.homeSchool || 'unknown'}). ` +
      `Returns: relevant policy text with source citations, confidence score, ` +
      `applicability notes, and whether adviser confirmation is needed. ` +
      `If a curated FAQ answer exists, returns it directly (matchedTemplateId). ` +
      `Call for policy questions, P/F rules, petition processes, or when the planner flags an uncertainty. ` +
      `NEVER answer a policy question from training data — always call this tool and cite the result.`
  },
  
  summarizeResult(result) {
    // If matched a curated template, use it directly — no synthesis needed
    if (result.matchedTemplateId) {
      return `Policy FAQ match (template: ${result.matchedTemplateId}, confidence: ${result.confidence}): ` +
        `"${result.topChunk.text}" (Source: ${result.topChunk.source}, ${result.topChunk.section}). ` +
        `Answerable: ${result.answerable}.` +
        (result.needsAdviserConfirmation ? ' NOTE: Adviser confirmation required.' : '') +
        (result.applicabilityNotes ? ` Applicability: ${result.applicabilityNotes}` : '')
    }
    if (result.confidence < 0.3) return `No confident policy match found (confidence: ${result.confidence}). Answerable: no.`
    return `Policy (confidence: ${result.confidence}): "${result.topChunk.text}" ` +
      `(Source: ${result.topChunk.source}, ${result.topChunk.section}). ` +
      `Answerable: ${result.answerable}.` +
      (result.needsAdviserConfirmation ? ' NOTE: Adviser confirmation required.' : '') +
      (result.applicabilityNotes ? ` Applicability: ${result.applicabilityNotes}` : '')
  },
})
```

#### `update_profile` — The Write Tool (Two-Step Confirmation)

> **This is the ONLY non-read-only tool.** It allows the agent to modify the student profile through natural language conversation. It uses a **two-step execution model** to prevent accidental mutations.

**Why this tool exists:** Without it, a student who says "I actually don't have AP Calculus" would need to navigate to a settings page and manually edit their transfer credits. This breaks the natural language advising experience.

**Safety rule:** The LLM must NEVER silently mutate the profile. Every mutation requires explicit student confirmation.

| Student Says | Intent | Mutation? |
|-------------|--------|----------|
| "I dropped my minor" | Remove program | ✅ Yes — after confirmation |
| "I'm *thinking about* dropping my minor" | Exploratory | ❌ No — use `what_if_audit` instead |
| "I actually don't have AP Calc" | Remove transfer credit | ✅ Yes — after confirmation |
| "I forgot to mention I have F-1 visa" | Add visa status | ✅ Yes — after confirmation (high-stakes) |
| "I'm now a double major with Econ" | Add program (declared) | ✅ Yes — after confirmation |
| "I'm exploring CS and Math" | Add programs (exploring) | ✅ Yes — adds both with `status: "exploring"` |
| "I want to transfer to Stern" | Add program (intended) | ✅ Yes — adds Stern with `status: "intended"` |
| "I'm undeclared" | Acknowledge, set no programs | ❌ No mutation — system accepts and runs school_only mode |
| "I officially declared CS" | Update program status | ✅ Yes — changes CS from "exploring" → "declared" |

```typescript
const updateProfile = buildTool({
  name: 'update_profile',
  isReadOnly: false,
  isConcurrencySafe: false,  // NEVER runs in parallel
  maxResultChars: 1000,
  
  inputSchema: z.object({
    mutations: z.array(z.object({
      action: z.enum(['add', 'remove', 'update']),
      field: z.enum([
        'transferCourses', 'coursesTaken', 'declaredPrograms',
        'visaStatus', 'flags', 'preferences',
        'targetGraduationTerm', 'workloadPreference',
        'homeSchool', 'isExternalTransfer'
      ]),
      value: z.any(),            // The data to add/update
      match: z.any().optional(), // For remove: which item to match
      reason: z.string(),        // Why (for audit log)
    })),
  }),
  
  validateInput(input) {
    for (const m of input.mutations) {
      // Block ambiguous mutations
      if (!m.reason || m.reason.length < 5) {
        return { valid: false, message: "Provide a reason for the profile change." }
      }
      // Require extra caution for high-stakes fields
      if (m.field === 'visaStatus' && m.action === 'remove') {
        return { valid: false, message: "Cannot remove visa status. Update it instead." }
      }
    }
    return { valid: true }
  },
  
  // CRITICAL: This tool does NOT apply the mutation immediately.
  // It returns a PREVIEW. The agent must show the preview to the student
  // and call confirm_profile_update only after the student says "yes".
  async call(input, { profile }) {
    const preview = computeMutationPreview(input.mutations, profile);
    return {
      status: 'pending_confirmation',
      pendingMutationId: crypto.randomUUID(),
      mutations: preview.changes.map(c => ({
        field: c.field,
        action: c.action,
        before: c.oldValue,
        after: c.newValue,
      })),
      impacts: preview.impacts,  // e.g. ["Audit will change", "Credits drop by 8"]
      confirmationPrompt: preview.summary,
      // The agent MUST show this to the student before proceeding
    };
  },
  
  prompt(profile) {
    return `Update the student's academic profile when they correct or add information. ` +
      `This tool returns a PREVIEW — it does NOT apply changes immediately. ` +
      `After receiving the preview, you MUST show the student what will change ` +
      `and ask for explicit confirmation before calling confirm_profile_update. ` +
      `NEVER call this tool for exploratory statements like "I'm thinking about..." ` +
      `or "what if I...". Only call for definitive corrections or additions.`
  },
  
  summarizeResult(result) {
    if (result.status === 'pending_confirmation') {
      return `Profile update preview (${result.mutations.length} change(s)): ` +
        result.mutations.map(m => `${m.action} ${m.field}: ${JSON.stringify(m.before)} → ${JSON.stringify(m.after)}`).join('; ') +
        `. Impacts: ${result.impacts.join(', ')}. AWAITING STUDENT CONFIRMATION.`
    }
    return `Profile update: ${result.status}`
  },
})
```

**After confirmation — mandatory tool re-invocation:**

When a profile mutation is confirmed, the agent MUST re-call affected tools before answering any subsequent questions. Stale results from before the mutation are invalid.

| Mutation Field | Tools That Must Re-Run |
|---------------|------------------------|
| `transferCourses` | `run_full_audit`, `plan_semester` |
| `coursesTaken` | `run_full_audit`, `plan_semester` |
| `declaredPrograms` | `run_full_audit`, `check_overlap`, `plan_semester` |
| `visaStatus` | `get_enrollment_status`, `plan_semester` |
| `targetGraduationTerm` | `plan_semester` |
| `preferences` | `plan_semester` |
| `homeSchool` | `run_full_audit`, `get_credit_caps`, `plan_semester` |

#### `check_transfer_eligibility` — Internal School Transfer

> Answers the top-5 student question: "How do I transfer to Stern?" / "Am I eligible?" Uses scraped bulletin data for specific prerequisite courses, deadlines, and eligibility rules.

```typescript
const checkTransferEligibility = buildTool({
  name: 'check_transfer_eligibility',
  isReadOnly: true,
  maxResultChars: 1500,
  
  inputSchema: z.object({
    targetSchool: z.string().describe('School to transfer to, e.g. "stern", "tandon"'),
  }),
  
  validateInput(input, profile) {
    if (!profile.homeSchool) {
      return { valid: false, message: "What school are you currently in? (CAS, Tandon, Stern, etc.)" }
    }
    if (profile.homeSchool === input.targetSchool) {
      return { valid: false, message: `You're already in ${input.targetSchool}. Did you mean to change major within your school?` }
    }
    if (!profile.completedCourses?.length) {
      return { valid: false, message: "No transcript data. Ask: 'Please upload your transcript so I can check eligibility.'" }
    }
    return { valid: true }
  },
  
  prompt(profile) {
    return `Check internal transfer eligibility from ${profile.homeSchool} to a target school. ` +
      `Returns: whether student meets minimum credit threshold (32 credits = 1 year), ` +
      `prerequisite course checklist with satisfied/missing status, ` +
      `application deadline, disqualifiers, and next steps. ` +
      `Call when student asks about transferring between NYU schools. ` +
      `NOTE: GPA requirements are NOT published by most schools — always caveat this.`
  },
  
  async call(input, { profile }) {
    const reqs = loadTransferRequirements(profile.homeSchool, input.targetSchool)
    if (!reqs) return { status: 'unsupported', contact: 'NYU Office of Undergraduate Admissions' }
    
    const creditsCompleted = sumCredits(profile.completedCourses)
    const entryYear = creditsCompleted >= 64 ? 'junior' : 'sophomore'
    
    // Check disqualifiers
    const disqualified = reqs.disqualifiers?.find(d => 
      d === 'previously_external_transfer' && profile.isExternalTransfer
    )
    if (disqualified) {
      return { eligible: false, reason: reqs.disqualifierReasons[disqualified] }
    }
    
    // Check credit minimum (32 credits = 1 full year)
    if (creditsCompleted < reqs.minCreditsCompleted) {
      return { 
        eligible: false, 
        reason: `Need ${reqs.minCreditsCompleted} credits (you have ${creditsCompleted}). Complete your first year first.`,
        canApplyAfter: `${reqs.minCreditsCompleted - creditsCompleted} more credits`
      }
    }
    
    // Check prerequisite courses for the entry year
    const yearReqs = reqs.entryYearRequirements.find(r => r.entryYear === entryYear)
    const prereqStatus = yearReqs.requiredCourseCategories.map(cat => ({
      category: cat.category,
      required: cat.description,
      satisfied: profile.completedCourses.some(c => cat.satisfiedBy.includes(c.courseId)),
      courseTaken: profile.completedCourses.find(c => cat.satisfiedBy.includes(c.courseId))?.courseId
    }))
    
    return {
      eligible: prereqStatus.every(p => p.satisfied),
      entryYear,
      deadline: reqs.applicationDeadline,
      acceptedTerms: reqs.acceptedTerms,
      prereqStatus,
      missingPrereqs: prereqStatus.filter(p => !p.satisfied),
      notes: reqs.notes,
      gpaNote: 'Minimum GPA for internal transfer is not published. Contact the target school\'s admissions office.',
      equivalencyUrl: reqs.equivalencyUrl
    }
  },
  
  summarizeResult(result) {
    if (result.status === 'unsupported') return `Transfer data not available. Contact: ${result.contact}`
    const status = result.eligible ? 'ELIGIBLE' : 'NOT YET ELIGIBLE'
    const missing = result.missingPrereqs?.map(p => p.category).join(', ') || 'none'
    return `Transfer eligibility: ${status} (as ${result.entryYear}). ` +
      `Deadline: ${result.deadline}. Missing prereqs: ${missing}. ` +
      `${result.gpaNote}`
  },
})
```

#### `what_if_audit` — Hypothetical Program Comparison

> Answers "What if I switched to Econ?" or "Compare CS vs Math for me." Runs a read-only audit with hypothetical programs without modifying the profile.

```typescript
const whatIfAudit = buildTool({
  name: 'what_if_audit',
  isReadOnly: true,
  maxResultChars: 2500,
  
  inputSchema: z.object({
    hypotheticalPrograms: z.array(z.string())
      .describe('Program IDs to hypothetically audit, e.g. ["cas_econ_ba", "cas_math_minor"]'),
    compareWithCurrent: z.boolean().default(true)
      .describe('If true, compare hypothetical results with current declared programs'),
  }),
  
  validateInput(input, profile) {
    if (!profile.completedCourses?.length) {
      return { valid: false, message: "No transcript data. Ask: 'Please upload your transcript so I can compare.'" }
    }
    if (!profile.homeSchool) {
      return { valid: false, message: "What school are you in?" }
    }
    // Validate all hypothetical programs exist
    for (const pid of input.hypotheticalPrograms) {
      if (!programExists(pid)) {
        return { valid: false, message: `Program '${pid}' not found. Use search_courses to find the correct program ID.` }
      }
    }
    return { valid: true }
  },
  
  prompt(profile) {
    const current = profile.declaredPrograms?.map(p => p.name).join(', ') || 'undeclared'
    return `Run a hypothetical degree audit with different programs than currently declared (${current}). ` +
      `Returns: requirement status for hypothetical programs, how many current courses transfer, ` +
      `additional courses needed, and graduation timeline impact. ` +
      `Does NOT modify the student's profile. ` +
      `Call when student asks "what if I switched to...", "compare X vs Y", or "should I major in..."`
  },
  
  async call(input, { profile }) {
    // Run audit with hypothetical programs (read-only — doesn't touch profile)
    const hypotheticalProfile = { ...profile, declaredPrograms: 
      input.hypotheticalPrograms.map(pid => ({ programId: pid, status: 'declared' as const }))
    }
    const hypotheticalAudit = await runFullAudit(hypotheticalProfile)
    
    // Compare with current if requested
    let comparison = null
    if (input.compareWithCurrent && profile.declaredPrograms?.length) {
      const currentAudit = await runFullAudit(profile)
      comparison = {
        coursesTransferred: countOverlappingCourses(currentAudit, hypotheticalAudit),
        additionalCoursesNeeded: hypotheticalAudit.remainingTotal - currentAudit.remainingTotal,
        graduationImpact: estimateGraduationDelta(currentAudit, hypotheticalAudit),
        sharedRequirements: findSharedRequirements(currentAudit, hypotheticalAudit),
      }
    }
    
    return {
      hypotheticalAudit,
      comparison,
      insights: generateWhatIfInsights(hypotheticalAudit, comparison),
    }
  },
  
  summarizeResult(result) {
    const remaining = result.hypotheticalAudit.remainingTotal
    const comp = result.comparison
    if (comp) {
      return `What-if audit: ${remaining} requirements remaining. ` +
        `${comp.coursesTransferred} of your current courses would transfer. ` +
        `${comp.additionalCoursesNeeded > 0 ? comp.additionalCoursesNeeded + ' more courses needed' : 'No extra courses needed'}. ` +
        `Graduation impact: ${comp.graduationImpact}.`
    }
    return `What-if audit: ${remaining} requirements remaining for hypothetical programs.`
  },
})
```

### 7.3 Session Persistence & Cross-Session Memory

> **Design principle:** The `StudentProfile` IS the memory. No vector database needed. The structured profile captures everything the engine needs to compute correctly. The only gap — conversational context — is handled by lightweight session summaries.

**What does NOT need a memory database:**
- Past tool results (recomputed fresh from current profile every session)
- Past audit/plan outputs (stale — profile may have changed)
- Full conversation logs (privacy risk + context window bloat)

**Session lifecycle:**

```
SESSION START:
  1. Load StudentProfile from database (Firestore/Postgres)
  2. Load sessionSummaries[] (last 3 sessions, ~600 tokens total)
  3. Inject into system prompt:
     - Profile context (programs, visa, credits, etc.)
     - "Previous advising sessions:"
       • Apr 15: "Student explored adding a Math minor. Audit showed
         2 courses overlap. Decided to think about it."
       • Apr 10: "Planned Fall 2025 semester. 16 credits. Student
         concerned about taking CSO + Algorithms together."
  4. Engine recomputes everything fresh from current profile

DURING SESSION:
  5. messages[] carries full conversation context (agent loop)
  6. Profile mutations via update_profile → confirmed → saved in memory
  7. All tool results are current-session only

SESSION END:
  8. Persist updated StudentProfile to database
  9. Generate 1-paragraph session summary (LLM call, ~100 tokens):
     "Student corrected their AP credits (removed AP Calculus BC).
      Re-ran audit: now needs MATH-UA 121. Planned to take it Fall 2025."
 10. Append to sessionSummaries[], trim to last 5 (rolling window)
 11. Write sessionSummaries[] to database
```

**StudentProfile persistence additions** (beyond Appendix B):

```typescript
// Added to StudentProfile interface
interface StudentProfile {
  // ... existing fields from Appendix B ...
  
  // Cross-session memory
  preferences?: {
    avoidTimes?: string[];         // e.g. ["before 10am"]
    interests?: string[];          // e.g. ["AI", "systems"]
    workloadPreference?: 'light' | 'standard' | 'heavy';
  };
  advisingNotes?: string[];        // Agent-appended after each session
  sessionSummaries?: Array<{       // Rolling window of last 5
    date: string;
    summary: string;
  }>;
  lastSessionDate?: string;        // For "welcome back" context
}
```

---

## 8. Planning Pipeline

### 8.1 All Factors That Affect a Semester Plan

#### Layer A: Deterministic (18 checks, always computed)

| # | Factor | Source | How |
|---|--------|--------|-----|
| 1 | Remaining requirements | `run_full_audit()` → unmet rules | Drives which courses are needed |
| 2 | Prerequisite chains | `prereqGraph.ts` | Which courses are unlocked NOW |
| 3 | Course availability | FOSE API for target term | Filters to courses actually offered |
| 4 | Credit caps (per-school total, per-semester) | `creditCapValidator.ts` + SchoolConfig | Bounds the plan |
| 5 | School residency requirement | SchoolConfig.residency (suffix-based or total-NYU) | Warn if not on track |
| 6 | Non-home-school credit cap | SchoolConfig.creditCaps (varies per school) | Block/warn non-home-school suggestions |
| 7 | Major GPA ≥ threshold | Grade computation + SchoolConfig | Flag if at risk |
| 8 | Minor GPA ≥ threshold | Same | Same |
| 9 | Residency % per program | Count home-school vs external per program | Warn if approaching |
| 10 | Cross-program overlap (G1-G4) | `crossProgramAudit.ts` | Per-program maxSharedCourses, no triple-count |
| 11 | AP credit revocation | Equivalency check | Don't count revoked credits |
| 12 | Course repeat dedup | Transcript check | Don't double-count |
| 13 | Final-credits-in-school (if applicable) | SchoolConfig.finalCreditsInSchool | Enforce near graduation (CAS: 32, others: varies) |
| 14 | I/NR/W grades | Grade classification | ≠ earned; include in attempted |
| 15 | Priority scoring | `priorityScorer.ts` | Required > prereq-unlocker > elective |
| 16 | Difficulty balancing | `balancedSelector.ts` | Mix hard + easy |
| 17 | Graduation pacing | Remaining ÷ semesters | Target credits/semester |
| 18 | Prereq chain depth | `graduationRisk.ts` DFS | Critical-path bottlenecks |

#### Layer B: Profile-Dependent (agent MUST collect from user if missing)

| # | Factor | Profile Field | If Missing → Agent Says | Required? |
|---|--------|--------------|------------------------|-----------|
| 1 | Home school | `homeSchool` | "What school are you in? (CAS, Tandon, Stern, etc.)" | **REQUIRED** — system cannot function without this |
| 2 | F-1 visa status | `visaStatus` | "Are you on an F-1 visa? This affects your minimum credit load and online course limits." | **REQUIRED** |
| 3 | Target graduation | `targetGraduationTerm` | "When are you aiming to graduate?" | **REQUIRED** |
| 4 | Completed courses | `completedCourses` | "Please upload your transcript." | **REQUIRED** |
| 5 | Declared programs | `declaredPrograms[]` | "What's your major (and minor, if any)? It's OK if you're undeclared — I can still help." | **CONDITIONAL** — see below |
| 6 | Workload preference | `workloadPreference` | Proceed with default (16cr), caveat: "I'm aiming for 16 credits. Want lighter or heavier?" | OPTIONAL |
| 7 | Course interests | `preferences` | Proceed without, caveat: "No preferences applied. Tell me your interests." | OPTIONAL |

**Rule:** Fields 1-4 are **REQUIRED** — agent MUST collect before calling `plan_semester`. Fields 6-7 are **OPTIONAL** — agent proceeds with defaults and caveats.

**Field 5 (declaredPrograms) — CONDITIONAL logic:**
- If student says "I'm undeclared" → agent acknowledges, does NOT keep asking. System uses `school_only` audit mode (Core + credit caps + residency).
- If student says "I'm exploring CS and Math" → agent creates both as `status: "exploring"`. System runs exploratory audit showing both programs' requirements informally.
- If student says "I want to transfer to Stern" → agent creates Stern as `status: "intended"` and runs `check_transfer_eligibility`. Planner prioritizes transfer prerequisites.
- If student has a declared major → normal flow (status: "declared").

#### Layer C: RAG-Validated Uncertainties (checked AFTER plan generation)

| # | Uncertainty | Trigger | RAG Query |
|---|------------|---------|-----------|
| 1 | Online course for major/minor | `isOnline && satisfiesRequirement` | "Can online courses count for [school] [major] requirements?" |
| 2 | Non-home-school course implications | `!courseId.includes(schoolConfig.courseSuffix)` | "[school] non-home-school credit limit" |
| 3 | Graduate course eligibility | `courseLevel >= 1000` | "Undergraduate taking graduate course policy" |
| 4 | Department non-home-school limit | Non-home-school counting for major | "[department] non-home-school course limit" |
| 5 | Credit overload | `totalCredits > schoolConfig.maxCreditsPerSemester` | "[school] credit overload adviser approval" |

### 8.2 The Uncertainty Detection System

The planner outputs not just a plan, but an `uncertainties[]` array — things it detected but couldn't resolve deterministically:

```typescript
interface PlanUncertainty {
  type: 'online_for_major' | 'non_home_school_course' | 'grad_course' 
      | 'department_restriction' | 'petition_may_be_needed'
      | 'cross_school_enrollment' | 'residency_impact';
  courseId: string;
  description: string;
  suggestedPolicyQuery: string;  // What the agent should RAG-search
  severity: 'info' | 'warning' | 'blocker';
}
```

The **agent** then calls `search_policy` for each uncertainty, and based on RAG confidence:
- **≥ 0.6:** Add factual caveat with source citation
- **0.3-0.6:** Add warning + "confirm with adviser"
- **< 0.3:** Add stronger warning + specific contact information

### 8.3 Complete Planning Flow (5 Steps)

```
USER: "Plan my next semester"

STEP 1: PRE-PLANNING DATA CHECK (agent validates profile)
  → Check for required fields → ask user if missing → wait for response

STEP 2: AUDIT (deterministic tool)
  → Agent calls run_full_audit(profile) → gets remaining requirements

STEP 3: PLAN (deterministic tool with uncertainty detection)
  → Agent calls plan_semester(profile, auditResult)
  → Returns: courses[], uncertainties[], risks[], missingDataCaveats[]

STEP 4: VALIDATE UNCERTAINTIES (RAG, only if uncertainties > 0)
  → For each uncertainty: agent calls search_policy(suggestedPolicyQuery)
  → Enriches response with policy citations or warnings

STEP 5: SYNTHESIZE (LLM generates final response)
  → Combines plan + validated uncertainties + caveats into clear response
  → States WHY each course was chosen
  → Flags risks and uncertainties with source citations
```

---

## 9. Safety & Fallback System

### 9.1 Eight-Part Framework

> **📖 Claude Code References for safety patterns:**
> - `Tool.ts` L321-336 — `ToolResult<T>` envelope. Success = return data. `contextModifier` for tools that change state.
> - `Tool.ts` L489-492 — `validateInput()`. Called before execution. Errors go to LLM as `is_error: true`.
> - `query/stopHooks.ts` (full file, 370 lines) — Post-response hooks that validate the model's output and inject blocking errors if validation fails. The model gets re-prompted with the error. **This is the pattern for our `responseValidator.ts`.**
> - `query.ts` L1282-1306 — When stop hooks return `blockingErrors`, they get appended to messages and the loop continues: `state = { messages: [...messages, ...assistantMessages, ...blockingErrors], stopHookActive: true, ... }; continue`. This is how we implement re-prompting on validation failure.
> - `services/tools/StreamingToolExecutor.ts` L153-205 — `createSyntheticErrorMessage()`. When a tool is cancelled (sibling error, user interrupt, streaming fallback), a synthetic `tool_result` with `is_error: true` is created so the LLM always gets a response for every `tool_use`.

```
1. STANDARDIZED TOOL CONTRACTS
   Every tool returns structured data — never throw-and-hope.
   Errors become messages the LLM can reason about.
   📖 See: Tool.ts L321-336 (ToolResult<T>), StreamingToolExecutor.ts L153-205 (synthetic errors)

2. INPUT VALIDATION (validateInput)
   Each tool validates its own preconditions.
   Missing data → tool tells LLM what to ask the user.
   📖 See: Tool.ts L489-492 (validateInput), query.ts L826-843 (tool_use detection)

3. CONFIDENCE GATING (RAG only)
   ≥ 0.6: cite    0.3-0.6: cite + warn    < 0.3: escalate + log

4a. RESPONSE VALIDATION — Grounding Checks (post-LLM)
    Before sending to user, check for:
    • Ungrounded numbers (GPA/credits not from a tool)
    • Uncited policies (claims without search_policy source)
    • False completions ("all requirements met" when audit says otherwise)
    • Hallucinated courses (recommendations not from plan_semester)
    If failed: re-prompt with constraints (max 2 retries → hard fallback)

4b. RESPONSE VALIDATION — Tool Invocation Auditing (NEW in v3.1)
    Before sending to user, check that REQUIRED tools were actually called.

    FORMAL CLAIM-TO-TOOL EVIDENCE CONTRACT:

    | If Response Contains...          | Required Tool Invocation       | If Missing → Action |
    |----------------------------------|-------------------------------|---------------------|
    | Credits remaining / earned       | `run_full_audit`              | Block + re-prompt: "Call run_full_audit" |
    | Degree requirements / progress   | `run_full_audit`              | Block + re-prompt |
    | GPA (cumulative or per-major)    | `get_academic_standing`       | Block + re-prompt |
    | Academic standing / SAP          | `get_academic_standing`       | Block + re-prompt |
    | Semester plan / course recs      | `plan_semester`               | Block + re-prompt |
    | Policy statement / regulation    | `search_policy`               | Block + re-prompt |
    | F-1 / visa / enrollment status   | `get_enrollment_status`       | Block + re-prompt |
    | Credit caps / P/F eligibility    | `get_credit_caps`             | Block + re-prompt |
    | Double-counting / overlap        | `check_overlap`               | Block + re-prompt |

    This is NOT a soft guideline — it is a hard contract enforced in code.
    If the LLM produces a response that discusses credits but never called
    `run_full_audit`, the response is BLOCKED regardless of whether the
    numbers happen to be correct. The system does not trust the LLM's
    training data for any factual claim in the above categories.

    WHY THIS IS NEEDED:
    validateInput() only fires when a tool IS called. It cannot catch the case
    where the LLM decides to answer from training data WITHOUT calling any tool.
    This check closes that gap.

    ```typescript
    // In responseValidator.ts
    function auditToolInvocations(
      response: string,
      toolsCalledThisTurn: string[],
    ): ValidationResult {
      const issues: string[] = [];

      // Detect claims about degree progress without audit
      if (mentionsCreditsOrRequirements(response) && !toolsCalledThisTurn.includes('run_full_audit')) {
        issues.push('Response discusses degree progress but run_full_audit was not called. Call it now.');
      }

      // Detect policy claims without search
      if (mentionsPolicyOrRule(response) && !toolsCalledThisTurn.includes('search_policy')) {
        issues.push('Response makes policy claims but search_policy was not called. Call it now.');
      }

      // Detect F-1/visa claims without enrollment check
      if (mentionsVisaOrEnrollment(response) && !toolsCalledThisTurn.includes('get_enrollment_status')) {
        issues.push('Response discusses enrollment/visa but get_enrollment_status was not called. Call it now.');
      }

      if (issues.length > 0) return { passed: false, repromptMessage: issues.join('\n') };
      return { passed: true };
    }
    ```

4c. RESPONSE VALIDATION — Completeness Checker (NEW in v3.1)
    After grounding and invocation checks pass, run a COMPLETENESS check:
    Given the student's profile, are there relevant constraints or caveats that
    the response FAILED to mention?

    WHY THIS IS NEEDED:
    The #1 risk in academic advising is not hallucination — it's OMISSION.
    A response that correctly discusses major requirements but fails to mention
    that the student is approaching the non-home-school credit cap, or that F-1 status
    requires 12 credits minimum, is "90% correct" but potentially harmful.

    ```typescript
    // In responseValidator.ts — runs AFTER grounding checks pass
    async function checkCompleteness(
      response: string,
      profile: StudentProfile,
      toolResults: ToolResult[],
    ): Promise<CompletenessResult> {
      // Profile-driven checks (no LLM needed)
      const missedCaveats: string[] = [];

      if (profile.visaStatus === 'F-1' && !response.toLowerCase().includes('f-1')
          && responseTouchesCourseLoad(response)) {
        missedCaveats.push('Student is F-1 but response does not mention visa-related enrollment constraints.');
      }

      if (profile.declaredPrograms.length > 1 && !response.toLowerCase().includes('overlap')
          && responseTouchesRequirements(response)) {
        missedCaveats.push('Student has multiple programs but response does not mention double-counting rules.');
      }

      // Non-home-school credit cap — uses SchoolConfig threshold
      const nonHomeSchoolCap = loadSchoolConfig(profile.homeSchool).creditCaps
        .find(c => c.type === 'non_home_school');
      if (nonHomeSchoolCap && profile.nonHomeSchoolCredits > nonHomeSchoolCap.maxCredits * 0.75
          && !response.includes('non-') && !response.includes('outside')
          && responseTouchesCreditCount(response)) {
        missedCaveats.push(`Student is approaching ${profile.homeSchool} non-home-school credit cap but response does not mention it.`);
      }

      // Graduation proximity — uses per-program totalCreditsRequired
      const totalRequired = profile.declaredPrograms?.[0]?.totalCreditsRequired || 128;
      if (profile.totalCredits > (totalRequired - 16) && !response.includes('graduation')
          && responseTouchesPlanning(response)) {
        missedCaveats.push('Student is near graduation but response does not address timeline.');
      }

      // If deterministic checks flag issues, re-prompt to add missing context
      if (missedCaveats.length > 0) {
        return {
          complete: false,
          repromptMessage: `Your response is missing important context for this student:\n` +
            missedCaveats.map(c => `• ${c}`).join('\n') +
            `\nPlease revise to include these relevant constraints.`,
        };
      }
      return { complete: true };
    }
    ```

    NOTE: This is NOT an LLM-powered check — it uses deterministic profile-based
    heuristics. This avoids the "LLM checking LLM" anti-pattern while still
    catching the most impactful omissions.

5. FALLBACK TEMPLATES
   When tool returns "unsupported":
   → "[Program X] isn't in my system yet. Contact your school's advising office."
   When RAG confidence < 0.3:
   → "I couldn't find a specific NYU policy. For a definitive answer, contact [resource]."
   📖 See: coordinator/coordinatorMode.ts L229-237 (handling worker failures — same pattern)

6. MANDATORY LOGGING
   Every fallback event → fallback_log.jsonl:
   { timestamp, category, toolName, query, reason, response, sessionId }

   Also log on every validation intervention:
   { timestamp, category: "validation_blocked", checkType: "invocation_audit" | "completeness" | "grounding",
     details, toolsCalled, profileFlags, sessionId }

7. SYSTEM PROMPT RULES (25 rules)
   Explicit behavioral constraints the LLM must follow.
   See Appendix A for the full system prompt.

8. MONITORING & ITERATION
   Weekly review of fallback_log.jsonl:
   - "tool_unsupported" → prioritize adding those programs
   - "low_confidence_rag" → improve policy doc coverage
   - "missing_user_data" → add to onboarding flow
   - "response_blocked" → strengthen system prompt rules
   - "validation_blocked/invocation_audit" → agent skipping tools, tune system prompt
   - "validation_blocked/completeness" → agent omitting caveats, add to prompt rules
```

### 9.2 What Happens When Data Is Insufficient

```
SCENARIO: User says "Plan my semester" without transcript

Agent (validateInput on run_full_audit):
  → Gets: { valid: false, message: "No transcript data. Ask to upload." }
  → Does NOT call plan_semester
  → Responds: "I'd love to plan your semester! First, please upload your transcript
    so I can see what you've completed. I also need your major and target graduation date."

SCENARIO: User asks about a program not in the system

Agent (check_overlap or run_full_audit):
  → Gets: { status: "unsupported", reason: "No JSON file for Sociology BA" }
  → Responds: "I don't have the Sociology BA requirements in my system yet.
    For Sociology advising, contact: sociology.advising@nyu.edu"
  → Logged to fallback_log.jsonl as tool_unsupported

SCENARIO: User asks a policy question RAG can't answer

Agent (search_policy):
  → Gets: { confidence: 0.15, topChunk: "..." }
  → Responds: "I couldn't find a specific NYU policy that directly answers this.
    For a definitive answer, I'd recommend contacting your school's advising office."
    (Agent uses schoolConfig.advisingContact to provide specific email/link)
  → Logged to fallback_log.jsonl as low_confidence_rag
```

---

## 10. Deterministic vs RAG Decision Matrix

### 10.1 The Complete Classification

This is the definitive answer to: **"For each policy/rule, do we write code or use RAG?"**

#### DETERMINISTIC (code-once, data-per-school/program)

These are **generic algorithms** that read SchoolConfig and per-program JSON files. Adding a new school/major means adding config/data files, not writing new code.

> **Note:** Gap IDs (G1–G45) originated from the CAS-specific v1 audit. In the multi-school architecture, the logic is generic but **thresholds and values are read from SchoolConfig and program JSON**, not hardcoded.

| Gap | What | Implementation | Config Source | Why Deterministic |
|-----|------|----------------|---------------|-------------------|
| G1-G4 | Cross-program overlap | `crossProgramAudit.ts` counter | `program.maxSharedCourses` (default 2) | Binary math: count shared courses ≤ N |
| G5-G6 | Major/Minor GPA threshold | `gpaCalculator.ts` | `schoolConfig.gradeThresholds.majorMinGpa` | Number comparison |
| G7-G8 | Residency % per program | Counter + threshold | `schoolConfig.residency.minPercent` (typically 50%) | Number comparison |
| G9 | Final credits in school | Credit ordering check | `schoolConfig.finalCreditsInSchool` (CAS: 32, others: varies/null) | Sequence check — **not all schools have this rule** |
| G10 | Near-graduation credit flexibility | Credit sum validation | `program.totalCreditsRequired - 2` | Arithmetic |
| G11 | AP credit revocation | `resolveExamCredit.ts` conditional | Per-school equivalency tables | Lookup table + boolean |
| G12 | Course repeat dedup | Transcript dedup filter | — (universal logic) | Set operation |
| G13 | School residency credits | Counter | `schoolConfig.residency` (CAS: 64 -UA, Steinhardt: 56 any-NYU, Tandon: 64 -UY) | Arithmetic — **threshold AND suffix vary per school** |
| G15 | Course repeat limits | Count per course | `schoolConfig.maxCourseRepeats` (typically 2) | Counter ≤ N |
| G16 | Overload detection | Credit sum | `schoolConfig.maxCreditsPerSemester` (all: 18, but GPA thresholds for approval vary) | Arithmetic |
| G17 | Time limit for degree | Date comparison | `schoolConfig.degreTimeLimitYears` (CAS: 8, others: varies/null) | Date math — **not all schools have this** |
| G18 | SAP completion rate | earned / attempted | `schoolConfig.sapThreshold` (typically 67%) | Division (W/NR/F in attempted) |
| G19 | Independent study cap | Credit sum by type | `schoolConfig.creditCaps[type='independent_study']` (CAS: 12cr, 8/dept, includes internship) | Counter |
| G20 | Online course limits | Count online courses | `schoolConfig.creditCaps[type='online']` | Counter |
| G27 | Graduation credit total | Credit sum | `program.totalCreditsRequired` (CAS: 128, SPS AAS: 60, Tandon: varies) | Arithmetic — **NOT a universal 128** |
| G29 | Non-home-school credit cap | Non-home-school counter | `schoolConfig.creditCaps[type='non_home_school']` (CAS: 16cr, Tandon: 4 courses, Stern: 32cr transfer) | Counter ≤ school-specific limit |
| G31 | Advanced standing cap | AP+IB+dual sum | `schoolConfig.creditCaps[type='advanced_standing']` (typically 32) | Counter ≤ N |
| G32-33 | I/NR grades ≠ earned | Grade filter array | — (universal logic) | Array inclusion |
| G34 | W in SAP attempted | SAP formula | — (universal logic) | Formula update |
| G35 | Grade thresholds | Grade threshold constants | `schoolConfig.gradeThresholds` (CAS: Core≥D/Major≥C, Tisch: Major≥C/no Core≥D) | Per-school comparison |

#### PROFILE FLAG + RAG EXPLAINS

These need a **simple boolean/enum** in the student profile, and the RAG layer explains the details.

| Gap | Profile Field | Deterministic Part | RAG Part |
|-----|--------------|-------------------|----------|
| G36 | `foreignLanguageExempt: boolean` | Skip FL requirement if true | Explains HOW to get exempt |
| G37 | `standingLevel: string` | Risk detector warns if GPA < threshold | Explains escalation levels (per-school) |
| G39 | (in passfailGuard exception list) | One `if` for early FL courses | Explains the exception |
| G40 | `catalogYear: number` | Which program JSON to load | Explains readmission rules |
| G41 | (in G29 allowlist) | 4 SPS prefixes allowed | Explains new SPS courses |

#### PURELY RAG (no code needed)

| Gap | Why RAG |
|-----|---------|
| G14 | Core exemptions — narrative policies, varies by department |
| G21 | Writing proficiency — explanation of the trigger condition |
| G22 | Graduate course policy — explanation of 1000 vs 2000 level |
| G23-G24 | Dean's List / Latin honors — informational, student asks |
| G25 | Study abroad credits — per-program approval process |
| G26 | Summer restrictions — narrative policy |
| G28 | Dual enrollment restrictions — explanation |
| G38 | Course sequencing — per-department, poorly documented |
| G42 | Placement exams — FAQ answer |
| G43 | Transfer credit grades — FAQ answer |
| G44 | 10-year credit expiry — rare edge case |
| G45 | Dismissal at <50% — SAP already flags; RAG explains |

**PURELY RAG — Audit v2 Additions (Issues #6, #9):**

| Gap | What |
|-----|------|
| G51 | Stern Global Experience — RAG explains options (IBEX, semester away, short-term) |
| G54 | Dean's List — informational, thresholds in SchoolConfig for accuracy |

**DETERMINISTIC — Audit v2 Additions (Issues #1-5, #7-8, #10-11):**

| Gap | What | Implementation | Config Source |
|-----|------|---------------|---------------|
| G46 | Per-school P/F rules | `passfailGuard.ts` reads config | `SchoolConfig.passFail` — 6 schools, 6 different rule sets |
| G47 | SPS enrollment blocker | `spsEnrollmentGuard.ts` | `SchoolConfig.spsPolicy` — total ban vs partial allowlist |
| G48 | Asymmetric double-counting | `crossProgramAudit.ts` | `SchoolConfig.doubleCounting` — M-M vs M-m per school |
| G49 | Transfer credit limits | `creditCapValidator.ts` | `SchoolConfig.transferCreditLimits` — NYU-wide 32 + per-school |
| G50 | Advanced standing eligibility | Flag + RAG | `SchoolConfig.acceptsTransferCredit` boolean |
| G52 | Stern LAS elective minimum | `ruleEvaluator.ts` courseFilter | Rule JSON with `suffix_allowlist` |
| G53 | Tiered overload GPA | `creditCapValidator.ts` | `SchoolConfig.overloadRequirements[]` array |
| G55 | LS forced-exit lifecycle | `crossProgramAudit.ts` dual-audit | `SchoolConfig.lifecycle` |
| G56 | Concentration program type | `gpaCalculator.ts` + `crossProgramAudit.ts` | `ProgramType = "concentration"` |
| G57 | Departmental honors tracks | `ruleEvaluator.ts` additive track merge | `tracks[].gpaGate` + `additionalCredits` in program JSON |
| G58 | Per-major study abroad residency | `ruleEvaluator.ts` majorResidency check | `program.majorResidency` — prefix-based counting |
| G59 | Nursing P/F 25% + exclusions | `passfailGuard.ts` | `careerLimitType: "percent_of_program"` + `excludedCourseTypes` array |
| G60 | Tandon internship 6-credit cap | `creditCapValidator.ts` | `creditCaps[type='internship']` with `gpaMinimum` |
| G61 | CAS SPS internship/indep. study ban | `spsEnrollmentGuard.ts` | `spsPolicy.excludedCourseTypes` filter |
| G62 | Steinhardt dept-discretionary sharing | `crossProgramAudit.ts` + RAG | `doubleCounting.overrideByProgram` + `requiresDepartmentApproval` |

### 10.2 Summary Count

| Category | Count | New Code | Config Source |
|----------|-------|----------|---------------|
| **Deterministic** (code-once, config-driven) | 35 caps/checks | ~210 lines across 5 files (+2 new files) | SchoolConfig + program JSON provide all thresholds |
| **Profile flag + RAG** | 7 items | 7 fields in types + few `if` checks | — |
| **Purely RAG** | 15 items | Zero code — just policy doc chunks | — |
| **Already in codebase** | ~10 items | Existing — verify correctness | Verify against SchoolConfig values |

> **Key insight:** The 35 deterministic checks use the **same algorithms** for every school — what changes is the **data**. A CAS student's P/F guard reads `{ careerLimitType: "credits", careerLimit: 32, canElect: true }` while a Nursing student's reads `{ careerLimitType: "percent_of_program", careerLimit: 0.25, excludedCourseTypes: ["CORE-UA", "nursing_sequence", ...] }`. Same function, different config.

---

## 11. Data Architecture

### 11.1 Separation Principle: School Config vs Program Rules

> **Code is unified. Data is separated by school.** The rule evaluator, credit cap validator, and planner are school-agnostic. What changes per school is configuration, not logic.

| Layer | What It Contains | Varies By | Engine Code? |
|-------|-----------------|-----------|-------------|
| **School Config** | Residency rules, credit caps, course suffix, GPA thresholds | School | Read by creditCapValidator, residencyChecker |
| **Program Rules** | Major/minor requirements, elective pools, substitutions | Major | Read by ruleEvaluator |
| **Course Data** | Full course catalog with flags, levels, prereqs | University-wide | Read by prereqGraph, searchCourses |

#### Complete NYU Undergraduate School Registry

| # | School | Suffix | Degree(s) | Priority | Notes |
|---|--------|--------|-----------|----------|-------|
| 1 | **CAS** (College of Arts & Science) | `-UA` | BA | 🔴 P0 — Launch | Largest school. Most majors. |
| 2 | **Tandon** (Engineering) | `-UY` | BS | 🟠 P1 | HUSS requirements, ethics course. |
| 3 | **Stern** (Business) | `-UB` | BS | 🟠 P1 | Concentrations, Social Impact Core sequence. |
| 4 | **Tisch** (Arts) | `-UT` | BFA, BM | 🟡 P2 | Gen Ed + studio split, department-specific. |
| 5 | **Steinhardt** (Education/Health) | `-UE` | BS, BA | 🟡 P2 | Fieldwork hours, teacher certification. |
| 6 | **Gallatin** (Individualized Study) | `-UG` | BA | 🟡 P2 | 31cr business cap, capstone, no fixed major. |
| 7 | **Liberal Studies** (LS) | `-UL` | BA (GLS) | 🟡 P2 | **2-year feeder + 4-year GLS option** (see below). |
| 8 | **SPS** (Professional Studies) | `-UC` | BS, BA | 🟢 P3 | DAUS division. Hospitality, Real Estate, Sport Mgmt. |
| 9 | **Silver** (Social Work) | `-US` | BS | 🟢 P3 | Small undergrad program (BS in Social Work). 3.0 major GPA. |
| 10 | **Nursing** (Rory Meyers) | `-UN` | BS | 🟢 P3 | BS in Nursing. Clinical/practicum hours. |
| 11 | **Dentistry** (College of Dentistry) | `-UD` | BS | 🟢 P3 | BS in Dental Hygiene only. Very small. |

> **Liberal Studies special case:** LS is unique — most students spend 2 years in the LS Core curriculum, then **transfer internally** to CAS, Stern, Gallatin, etc. as juniors. The 4-year option is Global Liberal Studies (GLS) BA. For the engine:
> - LS Core courses map to destination school requirements via an `equivalenceMap` in the LS school config
> - After internal transfer, the student's `homeSchool` changes and the destination school's config takes over
> - GLS students who stay 4 years use `gallatin`-style concentration rules (individualized)

```
data/
  schools/                              ← School-level policy configs (12 schools)
    cas.json                            CAS: -UA suffix, suffix_based residency (64cr), Core config
    tandon.json                         Tandon: -UY suffix, suffix_based residency (64cr), 4-course outside limit
    stern.json                          Stern: -UB suffix, concentration rules, Global Experience milestone
    tisch.json                          Tisch: gen ed structure, BFA studio rules
    steinhardt.json                     Steinhardt: total_nyu_credits residency (56cr), GPH programExclusions
    gallatin.json                       Gallatin: auditMode "advising_only", 31cr business cap, capstone
    ls.json                             Liberal Studies: LS Core sequences, GLS concentration
    sps.json                            SPS: [-UC, -CE] multi-suffix, total_nyu_credits residency
    silver.json                         Silver: 3.0 major GPA, total_nyu_credits residency, field instruction
    nursing.json                        Nursing (Meyers): -UN suffix, 25% P/F cap, clinical milestones, C-in-nursing grade threshold
    dentistry.json                      Dentistry: dental hygiene only
    gph.json                            GPH (cross-school with Steinhardt)

  programs/                             ← Major/minor rules, organized by school
    cas/
      cas_cs_ba.json                    degreeLevel: "bachelor", auditMode: "standard"
      cas_econ_ba.json                  tracks with trackRequirementsMode: "alternative"
      cas_math_ba.json
      cas_core.json                     CAS Core Curriculum (shared by all CAS students)
      cas_math_minor.json
      cas_bio_dentistry_ba_dds.json     degreeLevel: "combined", auditMode: "phased", phaseGates
    tandon/
      tandon_cs_bs.json                 creditRange, minCreditsPerCourse for science req
      tandon_ee_bs.json
      tandon_huss.json                  Tandon HUSS (shared by all Tandon students)
    stern/
      stern_business_bs.json            alternatives, minStanding, tracks w/ trackDeclarationDeadline
      stern_accounting_bs_ms.json       degreeLevel: "accelerated", phaseGates
    tisch/
      tisch_drama_bfa.json
      tisch_film_bfa.json
    steinhardt/
      steinhardt_childhood_ed_bs.json   maxSharedCourses: 1 (department-specific)
      steinhardt_applied_psych_bs.json  milestone (fieldwork), minStanding
    gallatin/
      gallatin_ba.json                  auditMode: "advising_only" (milestone-only rules)
    ls/
      ls_core.json                      2-year LS Core (shared program)
      ls_gls_ba.json                    4-year Global Liberal Studies BA
    sps/
      sps_leadership_bs.json            degreeLevel: "bachelor"
      sps_hospitality_bs.json
      sps_business_aas.json             degreeLevel: "associate", totalCreditsRequired: 60
      sps_health_admin_aas.json         degreeLevel: "associate", totalCreditsRequired: 60
    silver/
      silver_social_work_bs.json        milestone (Practicum I & II)
    nursing/
      nursing_bs.json
    dentistry/
      dentistry_hygiene_bs.json
    cross_school/
      wagner_public_policy_minor.json   poolConstraints: Wagner + Stern credits
      wagner_social_entrepreneurship_minor.json

  courses/                              ← Course catalog
    courses.json                        (or per-department files if > 5000)

  transfers/                            ← NEW: Internal transfer requirements
    cas_to_stern.json                   Prereqs (calculus, writing, stats, accounting, microecon)
    cas_to_tandon.json                  Engineering prereq courses
    cas_to_tisch.json                   Portfolio/audition requirement flag
    cas_to_steinhardt.json              Writing equivalencies by originating school
    cas_to_gallatin.json                64cr max, 31cr business cap carries over
    stern_to_cas.json
    tandon_to_cas.json
    ls_to_cas.json                      Liberal Studies → CAS transition (2-year feeder)
    ls_to_stern.json                    Liberal Studies → Stern transition
    _template.json                      Schema template for new pairs
```

### 11.2 School Config Schema

Each school config defines the policies that the engine applies when auditing students in that school:

```json
// data/schools/cas.json
{
  "schoolId": "cas",
  "name": "College of Arts and Science",
  "degreeType": "BA",
  "courseSuffix": ["-UA"],
  "totalCreditsRequired": 128,
  "overallGpaMin": 2.0,
  "residency": {
    "type": "suffix_based",
    "suffix": "-UA",
    "minCredits": 64,
    "finalCreditsInResidence": 32,
    "majorMinorResidencyPercent": 50
  },
  "creditCaps": [
    { "type": "non_home_school", "maxCredits": 16, "label": "Non-CAS courses (incl. SPS allowlist)" },
    { "type": "online", "maxCredits": 24, "label": "Online course credits (raised from 16 in Fall 2024)" },
    { "type": "transfer", "maxCredits": 64, "label": "Transfer credits" },
    { "type": "advanced_standing", "maxCredits": 32, "label": "AP/IB/A-Level credits" },
    { "type": "independent_study", "maxCredits": 12, "maxPerDepartment": 8,
      "includesInternship": true, "label": "Independent study + internship (max 8/dept)" }
  ],
  "gradeThresholds": {
    "core": "D",
    "major": "C",
    "minor": "C"
  },

  // ── P/F config (Issue #1) ──
  // Source: data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md
  "passFail": {
    "careerLimitType": "credits",
    "careerLimit": 32,
    "perTermLimit": 1,
    "perTermUnit": "semester",
    "countsForMajor": false,
    "countsForMinor": false,
    "countsForGenEd": false,
    "excludedCourseTypes": [],
    "canElect": true,
    "autoExcludedFromLimit": [],
    "gradePassEquivalent": "D",
    "failCountsInGpa": true,
    "exceptions": ["FL courses not used for FL requirement are P/F-eligible"]
  },

  // ── SPS enrollment policy (Issue #2) ──
  // Source: CAS academic policies — "College of Arts and Science now permits CAS students
  //   to take courses sponsored by SPS in these three areas" (effective Spring 2025)
  "spsPolicy": {
    "allowed": true,
    "allowedPrefixes": ["REBS1-UC", "TCHT1-UC", "TCSM1-UC", "RWLD1-UC"],
    "creditType": "elective_only",
    "countsTowardResidency": false,
    "countsAgainstNonHomeSchoolCap": true,
    "excludedCourseTypes": ["internship", "independent_study"]
  },

  // ── Double-counting rules (Issue #3) ──
  // Source: CAS academic policies — "No student may double count more than two courses
  //   between two majors (or between a major and a minor, or between two minors);
  //   some departments have set more restrictive sharing rules"
  "doubleCounting": {
    "defaultMajorToMajor": 2,
    "defaultMajorToMinor": 2,
    "defaultMinorToMinor": 2,
    "noTripleCounting": true,
    "requiresDepartmentApproval": true,
    "overrideByProgram": true
  },

  // ── Transfer credit limits (Issue #4) ──
  // Source: data/bulletin-raw/nyu/policies/transfer/_index.md — NYU-wide policy
  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 64,
    "springAdmitPostSecondaryMax": 8
  },

  "acceptsTransferCredit": true,
  "maxCreditsPerSemester": 18,
  "overloadRequirements": [
    { "condition": "default", "minGpa": 3.5, "note": "Adviser approval required" }
  ],
  "sapThreshold": 0.67,
  "maxCourseRepeats": 2,
  "sharedPrograms": ["cas_core"],
  "timeLimitYears": 8,
  "programExclusions": [],
  "deansListThreshold": { "minGpa": 3.65, "note": "Traditionally 3.65; see CAS honors page" },
  "advisingContact": {
    "name": "CAS Advising",
    "email": "cas.advising@nyu.edu",
    "url": "https://cas.nyu.edu/advising"
  }
}
```

```json
// data/schools/tandon.json
{
  "schoolId": "tandon",
  "name": "Tandon School of Engineering",
  "degreeType": "BS",
  "courseSuffix": ["-UY"],
  "totalCreditsRequired": 128,
  "overallGpaMin": 2.0,
  "residency": {
    "type": "suffix_based",
    "suffix": "-UY",
    "minCredits": 64,
    "finalCreditsInResidence": 32,
    "majorMinorResidencyPercent": 50
  },
  "creditCaps": [
    { "type": "non_home_school", "maxCourses": 4, "maxCredits": 16,
      "excludes": ["cross_school_minor", "study_abroad"],
      "label": "Non-Tandon courses (excl. minor/abroad)" },
    { "type": "internship", "maxCredits": 6, "gpaMinimum": 2.5,
      "additionalRules": ["no_incomplete_grades_from_prior_semesters"],
      "label": "Internship credits (CP or departmental)" }
  ],
  "gradeThresholds": {
    "major": "C"
  },

  // ── P/F config ──
  // Source: data/bulletin-raw/undergraduate/engineering/academic-policies/_index.md
  // "Students cannot elect to change the grading scale of classes to P/F
  //  if it is not already set up that way"
  "passFail": {
    "careerLimitType": "credits",
    "careerLimit": null,
    "perTermLimit": null,
    "perTermUnit": "semester",
    "countsForMajor": false,
    "countsForMinor": false,
    "canElect": false,
    "note": "Only courses already designated P/F by instructor are allowed"
  },

  // ── SPS policy ──
  // Source: Tandon academic policies — "Excluded from credit toward the degree
  //   are also any courses taken in the School of Professional Studies"
  "spsPolicy": { "allowed": false },

  // ── Double-counting ──
  // Source: Tandon academic policies — "some courses may be double counted towards
  //   both majors at the discretion of both academic departments"
  "doubleCounting": {
    "defaultMajorToMajor": null,
    "defaultMajorToMinor": null,
    "noTripleCounting": true,
    "requiresDepartmentApproval": true,
    "note": "No explicit numeric limit — department discretion"
  },

  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 64
  },
  "acceptsTransferCredit": true,
  "maxCreditsPerSemester": 18,
  "overloadRequirements": [
    { "condition": "probation", "maxCredits": 18, "note": "Capped at 18 on probation" },
    { "condition": "default", "minGpa": null, "note": "Adviser approval required" }
  ],
  "sapThreshold": 0.67,
  "maxCourseRepeats": 2,
  "sharedPrograms": ["tandon_huss"],
  "timeLimitYears": null,
  "programExclusions": [],
  "advisingContact": {
    "name": "Tandon Academic Advising",
    "email": "tandon.advising@nyu.edu",
    "url": "https://engineering.nyu.edu/academics/advising"
  }
}
```
```json
// data/schools/stern.json — Unique: concentrations, LAS requirement, SPS ban, P/F for major
// Source: data/bulletin-raw/undergraduate/business/academic-policies/_index.md
{
  "schoolId": "stern",
  "name": "Leonard N. Stern School of Business",
  "degreeType": "BS",
  "courseSuffix": ["-UB"],
  "totalCreditsRequired": 128,
  "overallGpaMin": 2.0,
  "residency": {
    "type": "suffix_based",
    "suffix": "-UB",
    "minCredits": 64,
    "finalCreditsInResidence": null,
    "majorMinorResidencyPercent": 50
  },
  "creditCaps": [
    { "type": "non_home_school", "maxCredits": 32, "subtype": "transfer_back",
      "label": "Non-business coursework transfer (max 32 total, max 8 at a time)" },
    { "type": "advanced_standing", "maxCredits": 32, "label": "AP/IB/A-Level credits" }
  ],

  "gradeThresholds": {
    "major": "C",
    "concentration": "C"
  },

  // ── P/F: dramatically different from CAS ──
  // Source: "A maximum of 4 courses may be elected pass/fail during a student's
  //   academic career. No more than one course may be elected pass/fail in an
  //   academic year... A course designated as pass/fail may be used to fulfill
  //   degree requirements (including BS in Business concentrations)"
  "passFail": {
    "careerLimitType": "courses",
    "careerLimit": 4,
    "perTermLimit": 1,
    "perTermUnit": "academic_year",
    "countsForMajor": true,
    "countsForMinor": true,
    "canElect": true,
    "autoExcludedFromLimit": ["IBEX", "CLP"],
    "excludedCourseTypes": ["stern_graduate", "bfa_film_tv"],
    "gradePassEquivalent": "D",
    "failCountsInGpa": true,
    "warnings": [
      "May impact enrollment in upper-level CAS math/CS courses",
      "May impact Dean's List, Valedictorian, honors eligibility"
    ]
  },

  // ── SPS: TOTAL BAN ──
  // Source: "Students do not receive credit for courses taken through the School
  //   of Professional Studies; therefore, Stern students are not permitted to
  //   enroll in courses through any SPS programs."
  "spsPolicy": { "allowed": false },

  // ── Double-counting: generally prohibited ──
  // Source: "Stern students are generally not permitted to count Stern coursework
  //   toward more than one requirement. In some situations, certain Stern courses
  //   taken as substitutes for specific curricular requirements may be used to
  //   satisfy both the requirement in question and an upper-level elective"
  "doubleCounting": {
    "defaultMajorToMajor": 0,
    "defaultMajorToMinor": 0,
    "defaultConcentrationToConcentration": 0,
    "noTripleCounting": true,
    "requiresDepartmentApproval": true,
    "note": "Generally prohibited; exceptions for substitute courses toward ULE"
  },

  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 64
  },
  "acceptsTransferCredit": true,
  "maxCreditsPerSemester": 18,

  // ── Tiered overload (Issue #8) ──
  // Source: "Permission to take more than 18 credits per term is limited to students
  //   who have completed at least 32 credits... cumulative GPA of 3.0 or better.
  //   First year students... only if the student has a GPA of 3.5 or better."
  "overloadRequirements": [
    { "condition": "firstYear", "minGpa": 3.5, "minSemesters": 1 },
    { "condition": "continuing", "minGpa": 3.0, "minCreditsCompleted": 32 }
  ],

  "sapThreshold": 0.67,
  "maxCourseRepeats": 2,
  "sharedPrograms": ["stern_business_core"],
  "timeLimitYears": null,
  "programExclusions": [],

  // ── Issue #11: concentrations are a first-class program type ──
  "supportedProgramTypes": ["major", "minor", "concentration"],

  "advisingContact": {
    "name": "Stern Office of Academic Advising",
    "email": "stern.advising@nyu.edu",
    "url": "https://www.stern.nyu.edu/portal-partners/current-students/undergraduate/advising"
  }
}
```

```json
// data/schools/steinhardt.json — Different residency model (total NYU credits, not suffix-based)
{
  "schoolId": "steinhardt",
  "name": "Steinhardt School of Culture, Education, and Human Development",
  "degreeType": "BS",
  "courseSuffix": ["-UE"],
  "totalCreditsRequired": 128,
  "overallGpaMin": 2.0,
  "residency": {
    "type": "total_nyu_credits",
    "minCredits": 56,
    "finalCreditsInResidence": 32,
    "majorMinorResidencyPercent": 50
  },
  "gradeThresholds": {
    "major": "C"
  },

  // ── P/F: percentage-based cap ──
  // Source: data/bulletin-raw/undergraduate/culture-education-human-development/academic-policies/_index.md
  // "the maximum of such courses is not to exceed 25 percent of the student's
  //  total program and not to exceed 25 percent in the student's academic plan"
  "passFail": {
    "careerLimitType": "percent_of_program",
    "careerLimit": 0.25,
    "careerLimitScope": "both_total_and_plan",
    "canElect": true,
    "countsForMajor": false,
    "countsForMinor": false,
    "note": "P/F students ineligible for Dean's List"
  },

  // ── Double-counting: department-specific ──
  // Source: "Students must then obtain written approval for the shared course(s)
  //   from the Program Director and/or Advisor of both programs.
  //   Some departments... have set more restrictive sharing rules
  //   (a limit of one shared course, or none at all)."
  "doubleCounting": {
    "defaultMajorToMajor": null,
    "defaultMajorToMinor": null,
    "noTripleCounting": true,
    "requiresDepartmentApproval": true,
    "overrideByProgram": {
      // Example: some Steinhardt departments prohibit all sharing
      "steinhardt_music_education_bs": { "majorToMajor": 0, "majorToMinor": 0 },
      // Others allow 1 shared course
      "steinhardt_media_culture_comm_bs": { "majorToMajor": 1, "majorToMinor": 1 }
    },
    "note": "No school-level default; defer to department. More restrictive rule wins."
  },

  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 72
  },
  "acceptsTransferCredit": true,
  "deansListThreshold": { "minGpa": 3.7, "minCredits": 12, "per": "term",
    "note": "No missing/N/I grades; P/F election disqualifies" },

  "sharedPrograms": [],
  "programExclusions": [
    {
      "if": ["steinhardt_gph_applied_psych_ba", "steinhardt_gph_csd_ba",
             "steinhardt_gph_mcc_ba", "steinhardt_gph_food_ba", "steinhardt_gph_nutrition_ba"],
      "thenCannotDeclare": "non_primary_major",
      "reason": "GPH co-major students cannot declare a non-primary major"
    }
  ]
}
```

```json
// data/schools/tisch.json — Unique: P/F elective-only, asymmetric double-counting, SPS partial
// Source: data/bulletin-raw/undergraduate/arts/academic-policies/_index.md
{
  "schoolId": "tisch",
  "name": "Tisch School of the Arts",
  "degreeType": "BFA",
  "courseSuffix": ["-UT"],
  "totalCreditsRequired": 128,
  "overallGpaMin": 2.0,
  "residency": {
    "type": "suffix_based",
    "suffix": "-UT",
    "minCredits": 64,
    "finalCreditsInResidence": null,
    "majorMinorResidencyPercent": 50
  },

  // ── P/F: elective credit ONLY, 32cr career cap ──
  // Source: "A student may only receive elective credit for courses taken pass/fail.
  //   Courses taken pass/fail may not fulfill major, minor, or general education
  //   requirements. No more than 32 credits of courses taken pass/fail can be
  //   counted toward the student's degree."
  "passFail": {
    "careerLimitType": "credits",
    "careerLimit": 32,
    "perTermLimit": 1,
    "perTermUnit": "semester",
    "countsForMajor": false,
    "countsForMinor": false,
    "countsForGenEd": false,
    "creditType": "elective_only",
    "canElect": true,
    "autoExcludedFromLimit": ["department_designated_pf"],
    "gradePassEquivalent": "D",
    "failCountsInGpa": true
  },

  // ── SPS: partial — specific departments only ──
  // Source: "Tisch students are able to enroll in School of Professional Studies (SPS)
  //   courses for elective credits (not general education credits). Allowable courses
  //   are courses from the Digital Communications and Media (DGCM1-UC, FILV1-UC),
  //   Hotel and Tourism Management (TCHT1-UC), Real Estate (REAL1-UC, REBS1-UC),
  //   Real World (RWLD1-UC), and Sports Management (TCSM1-UC) departments."
  "spsPolicy": {
    "allowed": true,
    "allowedPrefixes": ["DGCM1-UC", "FILV1-UC", "TCHT1-UC", "REAL1-UC", "REBS1-UC", "RWLD1-UC", "TCSM1-UC"],
    "creditType": "elective_only",
    "countsTowardResidency": false,
    "countsAgainstNonHomeSchoolCap": true
  },

  // ── Double-counting: asymmetric! major-to-major=2, major-to-minor=1 ──
  // Source: "No student may double count more than two courses between two majors,
  //   and no more than one course may be double counted between a major and a minor."
  // Also: "In cases where students pursue a second major within Tisch, exceptions
  //   may be made to allow for more than one course... at the discretion of both departments."
  "doubleCounting": {
    "defaultMajorToMajor": 2,
    "defaultMajorToMinor": 1,
    "noTripleCounting": true,
    "requiresDepartmentApproval": false,
    "exceptions": ["Within-Tisch double majors may allow more overlap at dept discretion"]
  },

  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 64
  },
  "acceptsTransferCredit": true,
  "deansListThreshold": { "minGpa": 3.65, "minCredits": 28, "per": "year",
    "note": "Computed per academic year Sep-May, not per semester" },

  // ── Tisch-specific: double major within production depts NOT allowed ──
  // Source: "Double majors in two production departments are not permitted."
  "programExclusions": [
    { "type": "cross_production_double_major",
      "note": "Double majors in two production departments are not permitted" }
  ],

  "advisingContact": {
    "name": "Tisch Office of Student Affairs",
    "email": "tisch.academic.services@nyu.edu",
    "url": "https://tisch.nyu.edu/student-affairs"
  }
}
```

```json
// data/schools/sps.json — Multiple suffixes, supports both AAS (60cr) and BS (128cr)
{
  "schoolId": "sps",
  "name": "School of Professional Studies",
  "degreeType": "BS",
  "courseSuffix": ["-UC", "-CE"],
  "totalCreditsRequired": 128,
  "overallGpaMin": 2.0,
  "residency": {
    "type": "total_nyu_credits",
    "minCredits": 56
  },
  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 80
  },
  "acceptsTransferCredit": true,
  "programExclusions": []
}
```

```json
// data/schools/gallatin.json — Advising-only mode (no fixed program requirements)
{
  "schoolId": "gallatin",
  "name": "Gallatin School of Individualized Study",
  "degreeType": "BA",
  "courseSuffix": ["-UG"],
  "totalCreditsRequired": 128,
  "overallGpaMin": 2.0,
  "auditMode": "advising_only",
  "residency": {
    "type": "total_nyu_credits",
    "minCredits": 64,
    "finalCreditsInResidence": 32,
    "note": "Last 32 credits must be at NYU-NY or NYU study away"
  },
  "creditCaps": [
    { "type": "specific_school", "schoolId": "stern", "maxCredits": 31,
      "label": "Stern business courses (max 31 credits)" }
  ],
  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 64
  },
  "acceptsTransferCredit": true,
  "programExclusions": []
}
```

```json
// data/schools/liberal_studies.json — Forced-exit program with lifecycle transitions
// Source: data/bulletin-raw/undergraduate/liberal-studies/academic-policies/_index.md
// "Liberal Studies Core is designed as a four-semester curriculum for students,
//  who are expected to make regular progress toward transition (or transfer) to
//  another school by the end of the fourth semester."
{
  "schoolId": "liberal_studies",
  "name": "Liberal Studies",
  "degreeType": null,
  "courseSuffix": ["-UF"],
  "totalCreditsRequired": null,
  "overallGpaMin": 2.0,

  // ── Issue #10: Forced-exit lifecycle ──
  "lifecycle": {
    "type": "forced_exit",
    "expectedTransitionSemesters": 4,
    "maxSemesters": 8,
    "transitionTarget": "other_nyu_school",
    "transitionRequires": ["concentration_planning_worksheet_approved"],
    "warningThreshold": 6,
    "warningMessage": "Notice of Academic Concern: Approaching Term Limit",
    "dismissalTrigger": "no_transition_by_semester_8",
    "dualAuditMode": true
  },

  "residency": {
    "type": "total_nyu_credits",
    "minCredits": null
  },
  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 64
  },
  "acceptsTransferCredit": true,
  "programExclusions": [],
  "advisingContact": {
    "name": "Liberal Studies Advising",
    "email": "ls.advising@nyu.edu",
    "url": "https://liberalstudies.nyu.edu"
  }
}
```

```json
// data/schools/nursing.json — Meyers College of Nursing
// Source: data/bulletin-raw/undergraduate/nursing/academic-policies/_index.md
// Percent-based P/F, clinical attendance milestones, and stricter grade thresholds
{
  "schoolId": "nursing",
  "name": "Rory Meyers College of Nursing",
  "degreeType": "BS",
  "courseSuffix": ["-UN"],
  "totalCreditsRequired": 128,
  "overallGpaMin": 2.0,
  "residency": {
    "type": "total_nyu_credits",
    "minCredits": 64,
    "finalCreditsInResidence": 32
  },

  // ── P/F: 25% of total program with specific exclusion categories ──
  // Source: "The maximum number of courses students may take Pass/Fail cannot
  //   exceed 25 percent of their total program of study. The Pass/Fail option
  //   is not available for CORE-UA courses or Introduction to Psychology.
  //   Furthermore, the Pass/Fail option is not available for science, nursing
  //   prerequisites, or nursing sequence courses."
  "passFail": {
    "careerLimitType": "percent_of_program",
    "careerLimit": 0.25,
    "canElect": true,
    "countsForMajor": false,
    "countsForMinor": false,
    "countsForGenEd": false,
    "excludedCourseTypes": ["CORE-UA", "nursing_prerequisite", "nursing_sequence",
                            "science", "PSYCH-UA 1"],
    "note": "Nursing cohort seminar is taken as P/F and is a graduation requirement (not counted against 25%)"
  },

  // ── Grade thresholds: nursing courses require C (73), not D ──
  // Source: "The passing grade for undergraduate program nursing prerequisite
  //   and nursing courses is a C (73-76)."
  "gradeThresholds": {
    "major": "C",
    "nursingPrerequisite": "C",
    "nonNursing": "D"
  },

  // ── Clinical attendance milestone ──
  // Source: "Meyers Clinical Attendance Policy"
  "milestones": [
    { "type": "clinical_attendance", "label": "Clinical hours completion",
      "note": "Absences, late arrivals, and injury/illness returns require documentation" }
  ],

  "transferCreditLimits": {
    "firstYearMaxTotal": 32,
    "transferStudentMaxTotal": 64
  },
  "acceptsTransferCredit": true,
  "deansListThreshold": { "minGpa": 3.5, "minCredits": 12, "per": "term" },
  "advisingContact": {
    "name": "Meyers College of Nursing Academic Advisement",
    "email": "nursing.advising@nyu.edu",
    "url": "https://nursing.nyu.edu"
  }
}
```

### 11.3 Extended Rule Schema (Cross-School Patterns)

The following schema extensions handle patterns discovered across all NYU schools:

#### a. `sequenced` — Ordered Course Sequences

**Where:** Stern Social Impact Core, Steinhardt professional sequence, Tisch studio sequence

```json
{
  "type": "must_take",
  "courses": ["MGMT-UB 1", "MGMT-UB 9", "MGMT-UB 12", "LAW-UB 1"],
  "sequenced": true,
  "label": "Social Impact Core (must be taken in order, one per semester)"
}
```

When `sequenced: true`, the planner schedules at most 1 course from this rule per semester.

#### b. `excludePool` — Course Exclusion Filters

**Where:** Tandon HUSS ("no skill courses"), CAS ("courses not applicable to major")

```json
{
  "type": "choose_n",
  "n": 4,
  "fromPool": ["AH-UY *", "EN-UY *", "HI-UY *", "PL-UY *"],
  "excludePool": ["*-UY 1*"],
  "excludeFlags": ["skill_course"],
  "label": "HUSS Electives (no introductory or skill courses)"
}
```

#### c. `tracks` — Concentration / Specialization Within a Major

**Where:** Stern (business concentrations), Econ (Theory vs Policy), History (regional tracks)

```json
{
  "programId": "cas_econ_ba",
  "tracks": [
    {
      "trackId": "theory",
      "label": "Theory Track",
      "rules": [
        { "type": "choose_n", "n": 3, "fromPool": ["ECON-UA 30*", "ECON-UA 32*"] }
      ]
    },
    {
      "trackId": "policy",
      "label": "Policy Track",
      "rules": [
        { "type": "choose_n", "n": 3, "fromPool": ["ECON-UA 31*", "ECON-UA 33*"] }
      ]
    }
  ],
  "trackSelectionPolicy": "choose_one",
  "trackDeclarationDeadline": "end_of_junior_year",
  "trackRequirementsMode": "additive"
}
```

- `trackDeclarationDeadline`: When the student must declare (Stern: "by end of junior year").
- `trackRequirementsMode`: `"alternative"` (tracks replace each other, e.g., Econ Theory vs Policy) or `"additive"` (track rules stack on top of base requirements, e.g., Stern concentrations add 12 credits on top of the business core).

The evaluator merges the selected track's rules into the active rule set. If the student hasn't declared a track, the audit marks it as `"status": "track_selection_required"`.

**Honors programs as additive tracks:**

Many CAS majors offer departmental honors as a track with `trackRequirementsMode: "additive"` — the honors track ADDS courses on top of the base major requirements, rather than replacing them.

```json
// Source: data/bulletin-raw/undergraduate/arts-science/programs/computer-science-ba/_index.md
// "The honors track requires fifteen 4-credit courses (60 credits), which is
//  three courses (12 credits) more than the non-honors track"
{
  "programId": "cas_cs_ba",
  "tracks": [
    {
      "trackId": "standard",
      "label": "Standard Track",
      "rules": []
    },
    {
      "trackId": "honors",
      "label": "Departmental Honors",
      "gpaGate": { "overall": 3.65, "inMajor": 3.65 },
      "admissionDeadline": "sophomore_year",
      "rules": [
        { "type": "must_take", "courses": ["CSCI-UA 421"], "label": "Numerical Computing (honors-only)" },
        { "type": "must_take", "courses": ["CSCI-UA 520", "CSCI-UA 521"], "label": "Undergraduate Research I & II",
          "sequenced": true },
        { "type": "milestone", "milestoneType": "thesis", "label": "Honors Thesis (40-60 pages)",
          "semesterConstraint": "senior_year",
          "note": "Presented at CAS Undergraduate Research Conference (April)" }
      ],
      "additionalCredits": 12,
      "note": "Requires consultation with DUS in both CS and Math departments"
    }
  ],
  "trackSelectionPolicy": "choose_one",
  "trackRequirementsMode": "additive"
}
```

```json
// Econ honors — different pattern: separate course sequence starting junior spring
// Source: data/bulletin-raw/undergraduate/arts-science/programs/economics-ba/_index.md
// "Students interested in graduate or professional school are especially urged to pursue honors.
//  A 3.65 overall GPA and a 3.65 average in economics courses are both required."
{
  "trackId": "honors",
  "label": "Honors in Economics",
  "gpaGate": { "overall": 3.65, "inMajor": 3.65 },
  "admissionDeadline": "sophomore_year",
  "rules": [
    { "type": "must_take", "courses": ["ECON-UA 800", "ECON-UA 801", "ECON-UA 802"],
      "label": "Honors Thesis Sequence (3 semesters)",
      "sequenced": true,
      "startConstraint": "junior_spring_or_earlier" }
  ]
}
```

The `gpaGate` field is a **standing gate for track entry**, not for course evaluation. If the student's GPA falls below the gate after enrollment, the audit emits a `track_gpa_risk` warning. The `admissionDeadline` tells the planner when to prompt the student about honors eligibility.

**Per-program major residency — study abroad credit limits:**

Some majors impose their own residency rule on top of the school-level residency. This prevents students from completing the majority of major courses at global sites.

```json
// Source: data/bulletin-raw/undergraduate/arts-science/programs/computer-science-ba/_index.md
// "At least half of the courses applied to the Courant requirements of the CAS
//  majors and minors in Computer Science and in Mathematics must be CSCI-UA and
//  MATH-UA courses taken in New York or at NYU study away sites."
// "This is a built-in limit on how many courses students may take in these
//  subjects that are sponsored by NYU Abu Dhabi and NYU Shanghai under
//  CS-UH, MATH-UH, CENG-SHU, CSCI-SHU, and MATH-SHU."
{
  "programId": "cas_cs_ba",
  "majorResidency": {
    "minPercent": 50,
    "countingSuffixes": ["CSCI-UA", "MATH-UA"],
    "excludedSuffixes": ["CS-UH", "MATH-UH", "CENG-SHU", "CSCI-SHU", "MATH-SHU"],
    "scope": "major_and_minor_courses",
    "label": "≥50% of Courant courses must be NYU-NY or NYU study-away (-UA)",
    "note": "Internal/external transfers must pay close attention"
  }
}
```

The rule evaluator checks `majorResidency` after computing which courses satisfy the program. If fewer than `minPercent`% of the used courses have prefixes matching `countingSuffixes`, the audit flags a `major_residency_risk`. The planner uses this to warn students before they register for too many NYUAD/NYUSH courses in their major.

#### d. `milestone` — Capstone / Thesis / Fieldwork Requirements

**Where:** Gallatin (Senior Colloquium), Steinhardt (student teaching, field hours), Tisch (senior thesis/showcase), Silver (field instruction)

This is a **5th rule type** — the only new rule type needed beyond the original 4:

```json
{
  "type": "milestone",
  "label": "Senior Colloquium",
  "milestoneType": "capstone",
  "semesterConstraint": "final_year",
  "prerequisites": ["all_core_complete"],
  "note": "Includes Intellectual Autobiography and Plan for Concentration"
}
```

```json
{
  "type": "milestone",
  "label": "Field Instruction I",
  "milestoneType": "fieldwork",
  "hoursRequired": 100,
  "semesterConstraint": "junior_year_or_later",
  "note": "Must be completed before student teaching"
}
```

The evaluator checks `milestone` rules against a `completedMilestones[]` array in the student profile. For fieldwork hours, the system flags the requirement but the student self-reports completion (or it's read from an external practicum system).

#### e. `alternatives` — OR-Course Patterns in `must_take` Rules

**Where:** Every school. Stern (ECON-UB 1 **or** ECON-UB 2), Tandon (CM-UY 1003 **or** CM-UY 1013), CAS (multiple intro sequences).

The `alternatives` field on a `must_take` rule defines acceptable substitutes for specific required courses:

```json
{
  "type": "must_take",
  "label": "Business Core - Statistics",
  "courses": ["STAT-UB 103"],
  "alternatives": {
    "STAT-UB 103": ["STAT-UB 3"]
  }
}
```

The evaluator checks: for each course in `courses`, is the course itself taken, OR is any of its `alternatives` taken? This preserves the semantic meaning that these are alternatives for the **same requirement slot** — important for advising ("you can take either one").

#### f. `minStanding` — Standing-Gated Requirements

**Where:** Stern (Functional Business Core requires sophomore standing), Steinhardt (clinical placements), Silver (practicum)

```json
{
  "type": "choose_n",
  "n": 5,
  "fromPool": ["ACCT-UB 4", "FINC-UB 2", "TECH-UB 1", "MGMT-UB 1", "MKTG-UB 1", "OPMG-UB 1", "MGMT-UB 2"],
  "minStanding": "sophomore",
  "label": "Functional Business Core (requires sophomore standing)"
}
```

When `minStanding` is set, the evaluator returns `{ satisfied: false, blocked: true, blockedReason }` if the student's standing is below the threshold. The planner uses this to defer these courses to the correct semester.

#### g. `poolConstraints` — Cross-School Pool Requirements

**Where:** Wagner cross-school minors ("8 credits from Wagner AND 6-8 from Stern")

```json
{
  "type": "min_credits",
  "minCredits": 14,
  "fromPool": ["PADM-UF *", "MGMT-UB *", "FINC-UB *"],
  "poolConstraints": [
    { "pool": ["PADM-UF *"], "minCredits": 8, "label": "Wagner courses" },
    { "pool": ["MGMT-UB *", "FINC-UB *"], "minCredits": 6, "label": "Stern courses" }
  ],
  "label": "Cross-school minor: Public Policy & Management"
}
```

The evaluator checks both the total `minCredits` AND each `poolConstraint` independently. If the total is met but a sub-pool falls short, the rule is not satisfied.

#### h. `creditRange` — Variable-Credit Selections

**Where:** Tandon science requirement ("select 3 courses" where courses are 3-4 credits each → 9-12 credit range)

```json
{
  "type": "choose_n",
  "n": 3,
  "fromPool": ["CM-UY 1003", "CM-UY 1013", "BMS-UY 1003", "PH-UY 1013", "PH-UY 2023", "PH-UY 2033"],
  "minCreditsPerCourse": 3,
  "creditRange": [9, 12],
  "label": "Science Requirement (9-12 credits)"
}
```

`creditRange` is **display-only** — it tells the UI to show "9-12 credits" instead of a fixed number. The evaluator uses `n` for satisfaction checking; actual credits earned will vary naturally based on course selection.

#### i. `global_experience` — Non-Course Milestone

**Where:** Stern (mandatory for Class of 2027+), potentially other schools

```json
{
  "type": "milestone",
  "label": "Global Experience Requirement",
  "milestoneType": "global_experience",
  "appliesFromCatalogYear": "2023-2024",
  "appliesFromClass": 2027,
  "note": "Semester away, IBEX, short-term immersion, or other NYU global programs"
}
```

The `appliesFromClass` field ensures this milestone only triggers for students graduating in 2027+. Older catalog years are exempt.

#### j. `courseFilter` — Suffix-Based Course Eligibility (Issue #7)

**Where:** Stern LAS (Liberal Arts & Sciences) elective minimum (NY State Board of Education requirement)

Stern students must complete a minimum number of LAS credits from approved schools. The allowed courses span multiple colleges but must be identifiable by suffix:

```json
{
  "type": "min_credits",
  "credits": 48,
  "label": "Liberal Arts & Sciences Electives (NY State requirement)",
  "courseFilter": {
    "type": "suffix_allowlist",
    "allowedSuffixes": ["-UA", "-UE", "-UT", "-GP", "-UG", "-US", "-GU", "-UY"],
    "excludedSuffixes": ["-UC", "-CE", "-UB"]
  },
  "note": "Not all courses at allowed schools qualify — adviser review recommended"
}
```

// Source: data/bulletin-raw/undergraduate/business/academic-policies/_index.md
// "Students are required to take a specific number of liberal arts and science
//  elective credits which varies depending on the degree program."
// "The liberal arts and sciences (LAS) comprise the disciplines of the humanities,
//  natural science and mathematics, and social sciences. This can include coursework
//  at: CAS (-UA); Steinhardt (-UE); Tisch (-UT); Wagner (-GP); Gallatin (-UG);
//  Silver (-US); GPH (-GU); and Tandon (-UY)."

The evaluator filters `completedCourses` by suffix before counting credits. If `courseFilter.type === 'suffix_allowlist'`, only courses whose `courseId` ends with one of `allowedSuffixes` AND NOT one of `excludedSuffixes` contribute to the credit count.

#### k. `lifecycle` — Forced-Exit Program Handling (Issue #10)

**Where:** Liberal Studies Core, potentially other feeder programs

When `SchoolConfig.lifecycle.type === 'forced_exit'`, the engine activates **dual-audit mode**:

1. **Primary audit:** Evaluates LS Core requirements (how much of the LS curriculum is complete?)
2. **Transition audit:** Evaluates the target school's entry requirements (will the student qualify for transition?)

```
StudentProfile.homeSchool === "liberal_studies"
  ├─ Run: audit(ls_core_requirements)          → { coreProgress: 75% }
  ├─ Run: audit(targetSchool.entryRequirements) → { transitionReady: false, missing: ["GPA >= 3.0"] }
  └─ Emit: lifecycle_warning if semestersCompleted >= lifecycle.warningThreshold
```

The planner for LS students prioritizes courses that satisfy BOTH LS Core requirements AND transition school prerequisites. When `semestersCompleted >= warningThreshold` (6), the system proactively warns about the term limit.

#### l. `phaseGates` — Accelerated / Combined Degree Progression

**Where:** CAS Biology/Dentistry BA-DDS (7-year combined), Stern BS/MS Accounting (150 credits), CAS Physics/Engineering BS-BS

Accelerated and combined degree programs have **phase-based progression** where students must meet GPA or course requirements to advance to the next phase:

```json
{
  "programId": "cas_bio_dentistry_ba_dds",
  "degreeLevel": "combined",
  "totalCreditsRequired": 297,
  "auditMode": "phased",
  "phaseGates": [
    {
      "phaseId": "undergrad",
      "label": "CAS Years 1-3",
      "afterYear": 3,
      "requiredGpa": 3.5,
      "requiredGpaScope": "both_overall_and_major",
      "minGradeInMajorCourses": "B",
      "passFail": "not_allowed_in_major",
      "advancesTo": "dental_school",
      "failureAction": "revert_to_biology_ba"
    }
  ]
}
```

```json
{
  "programId": "stern_accounting_bs_ms",
  "degreeLevel": "accelerated",
  "totalCreditsRequired": 150,
  "auditMode": "phased",
  "phaseGates": [
    {
      "phaseId": "apply",
      "label": "BS/MS Application",
      "afterYear": 1,
      "requiredGpa": 2.5,
      "requiredGpaScope": "overall",
      "minGradeInMajorCourses": "B-",
      "advancesTo": "ms_track"
    }
  ]
}
```

For `auditMode: "phased"`, the engine evaluates requirements for the current phase only and displays phase gate status. Until a student passes the gate, the next phase's requirements are shown as "locked." For v1, these programs are flagged as `"auditMode": "informational"` — the engine shows all requirements but caveats that progression gates require adviser verification.

### 11.4 Cross-School Audit Flow

When a student has programs across multiple schools (dual degree, cross-school minor), `crossProgramAudit.ts` orchestrates:

```
INPUT: Student with CAS CS BA + Tandon EE BS (dual degree)

STEP 0: Validate program declarations and classify audit mode
  → Check school-level programExclusions (e.g., GPH co-major blocks non-primary major)
  → If exclusion triggered: return { status: "declaration_error", reason: "..." }
  → Classify each program by status:
    - "declared" programs → full rule-based audit (obligations)
    - "exploring" programs → informational audit (show requirements, not obligations)
    - "intended" programs → load transfer requirements, run eligibility check
  → If NO programs at all (undeclared):
    - Load school Core requirements (e.g., cas_core.json)
    - Run school_only audit: Core progress + credit caps + residency + GPA
    - Skip all major-specific rule evaluation

STEP 1: Identify schools
  homeSchools = ["cas", "tandon"]
  Load: cas.json, tandon.json

STEP 2: Check school auditMode and program status
  → If auditMode === "advising_only" (Gallatin): skip rule audit, only track credit totals/caps/milestones
  → If auditMode === "phased" (combined degrees): evaluate current phase only, show gate status
  → If auditMode === "standard" (default): full rule-based audit
  → For "exploring" programs: run rules but tag all results as { informational: true }
    - Agent should present as "here's what you'd need" not "you're missing X"
  → For "intended" programs: run check_transfer_eligibility inline
    - Flag missing transfer prereqs as high-priority in planner output

STEP 3: Group programs by school
  CAS programs:    [cas_cs_ba, cas_core]
  Tandon programs: [tandon_ee_bs, tandon_huss]

STEP 4: Run per-school audits
  For CAS: run degreeAudit() with cas.json school config
    → Uses suffix-based residency (-UA, 64 credits)
    → Uses grade threshold: major ≥ C, core ≥ D
  For Tandon: run degreeAudit() with tandon.json school config
    → Uses suffix-based residency (-UY, 64 credits)
    → Uses its own grade thresholds

STEP 5: Cross-program checks
  → Substitution evaluation (§4.5)
  → Double-counting: use min(programA.maxSharedCourses, programB.maxSharedCourses)
    Default is 2, but per-program overrides apply (Steinhardt depts may be 0 or 1)
  → Credit cap enforcement PER SCHOOL (using each school's creditCaps config):
     - CAS cap: count Tandon courses toward non-home-school limit (CAS max: 16 credits)
     - Tandon cap: count CAS courses toward outside limit (Tandon max: 4 courses/16 credits)

STEP 6: Merge into unified view
  → Combined audit results with school labels
  → Unified remaining-requirements list
  → Cross-school warnings (if credit caps are tight)
  → Program exclusion warnings (if any)
```

The same flow handles:
- **CAS major + Stern cross-school minor:** CAS audit normal + Stern minor audit with Stern school config
- **Gallatin BA:** Single school, but Gallatin's 31-credit business cap is enforced by its school config
- **Tisch BFA + CAS minor:** Tisch audit with Tisch config + CAS minor with CAS school config

### 11.5 Per-Major JSON Schema (Updated)

Each major gets a single JSON file following the universal schema. Schema now includes `tracks`, `sequenced`, `excludePool`, `milestone`, `substitutions`, `alternatives`, `minStanding`, `poolConstraints`, `creditRange`, `maxSharedCourses`, `degreeLevel`, and `auditMode`:

```json
{
  "programId": "cas_cs_ba",
  "name": "Computer Science BA",
  "school": "cas",
  "department": "Computer Science",
  "catalogYear": "2024-2025",
  "degreeType": "major",
  "degreeLevel": "bachelor",
  "auditMode": "standard",
  "totalCreditsRequired": 128,
  "majorCreditsMin": 40,
  "majorGpaMin": 2.0,
  "maxSharedCourses": 2,
  "tracks": null,
  "phaseGates": null,
  "ruleGroups": [
    {
      "groupId": "cs_core",
      "label": "CS Core Courses",
      "rules": [
        {
          "ruleId": "cs_core_required",
          "type": "must_take",
          "label": "Required CS Courses",
          "courses": ["CSCI-UA 101", "CSCI-UA 102", "CSCI-UA 201", "CSCI-UA 202"],
          "context": "major",
          "doubleCountPolicy": "limit_1"
        },
        {
          "ruleId": "cs_electives",
          "type": "choose_n",
          "label": "CS Electives",
          "n": 4,
          "fromPool": ["CSCI-UA 4*", "CSCI-UA 310", "CSCI-UA 453"],
          "excludePool": ["CSCI-UA 330", "CSCI-UA 380"],
          "context": "major",
          "minLevel": 400,
          "doubleCountPolicy": "allow"
        }
      ]
    }
  ]
}
```

```json
// Example: SPS Business AAS — Associate degree (60 credits)
{
  "programId": "sps_business_aas",
  "name": "Business AAS",
  "school": "sps",
  "catalogYear": "2024-2025",
  "degreeType": "major",
  "degreeLevel": "associate",
  "auditMode": "standard",
  "totalCreditsRequired": 60,
  "majorCreditsMin": 28,
  "majorGpaMin": 2.0,
  "maxSharedCourses": 2,
  "ruleGroups": [...]
}
```

```json
// Example: Stern Business BS with alternatives and standing-gated requirements
{
  "programId": "stern_business_bs",
  "name": "Business BS",
  "school": "stern",
  "catalogYear": "2024-2025",
  "degreeType": "major",
  "degreeLevel": "bachelor",
  "totalCreditsRequired": 128,
  "majorGpaMin": 2.0,
  "maxSharedCourses": 2,
  "tracks": [...],
  "trackSelectionPolicy": "choose_one",
  "trackDeclarationDeadline": "end_of_junior_year",
  "trackRequirementsMode": "additive",
  "ruleGroups": [
    {
      "groupId": "business_core",
      "label": "Business Core",
      "rules": [
        {
          "ruleId": "stern_micro",
          "type": "must_take",
          "label": "Microeconomics",
          "courses": ["ECON-UB 1"],
          "alternatives": { "ECON-UB 1": ["ECON-UB 2"] }
        },
        {
          "ruleId": "stern_functional_core",
          "type": "choose_n",
          "label": "Functional Business Core (requires sophomore standing)",
          "n": 5,
          "fromPool": ["ACCT-UB 4", "FINC-UB 2", "TECH-UB 1", "MGMT-UB 1", 
                       "MKTG-UB 1", "OPMG-UB 1", "MGMT-UB 2"],
          "minStanding": "sophomore"
        }
      ]
    }
  ]
}
```

### 11.6 Scaling Strategy

```
Phase 5 pipeline for adding a new major:

1. SCRAPE: Pull requirements from NYU Bulletin 
   (https://bulletin.cas.nyu.edu/page/departments.and.programs)
   
2. DISTILL: Convert narrative requirements into JSON rules
   - Manual for first batch (10 majors)
   - LLM-assisted for remaining (with human verification)
   
3. VALIDATE: Run eval suite against known student scenarios
   
4. DEPLOY: Add JSON file to programs/ directory
   
5. UPDATE: Add department bulletin to RAG policy corpus

Time per major: ~2-4 hours (mostly manual verification)
Batch targets: 10 majors/sprint
```

### 11.3 Course Data

```
Current: packages/engine/src/data/courses.json (80 hand-curated courses)
Target:  Full NYU catalog via FOSE API scraping

FOSE API: https://schedge.a1liu.com/api/ (unofficial but comprehensive)
Fields: id, title, credits, termsOffered, sections, instructor, location

Scraping pipeline (Phase 5):
  1. Hit FOSE API for all CAS departments
  2. Normalize to our Course interface
  3. Extract: isOnline, courseLevel, suffix (-UA/-UC/-AD)
  4. Store as courses.json (or per-department files if > 5000 courses)
```

---

## 12. Migration Roadmap

### Codebase Reuse Analysis — Why We Keep the v1 Repo

> **Decision: Do NOT start a new repo.**
>
> The v1 codebase was built for a single major (CS BA) with a different orchestration layer (intent-routing pipeline). The v3.1 architecture replaces the orchestration but **reuses the deterministic engine**. A detailed audit of every file shows the following breakdown:

**Fully generic engine code (keep as-is): ~1,250 lines, 52%**

| File | Lines | Why It's Generic |
|------|-------|-----------------|
| `ruleEvaluator.ts` | 257 | Evaluates `Rule` objects against course sets. Handles `must_take`, `choose_n`, `min_credits`, `min_level` with wildcards. Zero CS-specific code. |
| `prereqGraph.ts` | 161 | Pure DAG operations. Takes any `Prerequisite[]`. Zero major-specific code. |
| `enrollmentValidator.ts` | 143 | F-1 visa rules. Applies to all students regardless of major. |
| `equivalenceResolver.ts` | ~120 | Cross-listing resolution. Uses `courses.json` data. Generic. |
| `balancedSelector.ts` | 308 | Credit-pacing algorithm. Takes `RuleAuditResult[]`. Generic. |
| `types.ts` (shared) | 268 | All types (`Rule`, `Program`, `StudentProfile`) are program-agnostic. Needs field extensions, not replacement. |

**Mostly generic, has CS-hardcoded spots (fix ~50 lines): ~940 lines, 39%**

| File | What's CS-Specific | Fix |
|------|--------------------|----|
| `degreeAudit.ts` | `isCSProgram` check (L237-240), `csciCreditsCompleted` counter (L109-119). | Move CSCI-UA minimum to program JSON as a `min_credits` rule. Delete ~15 lines. |
| `creditCapValidator.ts` | `checkCSCICredits()` function (L206-235). Only major-specific check; the other 6 checks are universal CAS rules. | Delete function, make credit-minimum a per-program rule. ~30 lines removed. |
| `priorityScorer.ts` | `isCorePrereq()` hardcodes CSCI-UA/MATH-UA courses (L163-173). | Replace with: read from program's `must_take` rules instead of hardcoded set. ~10 line change. |
| `semesterPlanner.ts` | Runs `degreeAudit` against a single `program` (L51). Doesn't multi-audit. | Loop over `declaredPrograms[]` and merge. ~20 lines changed. |

**Must be replaced (new architecture): ~1,290 lines, ~54% (mostly text, not logic)**

| File | Lines | Replacement |
|------|-------|-------------|
| `chatOrchestrator.ts` | 250 | `agent/agentOrchestrator.ts` — old pipeline → agent loop |
| `explanationGenerator.ts` | ~220 | Tool-driven synthesis + hardened templates |
| `intentRouter.ts` | ~100 | Agent's native tool selection replaces intent classification |
| `academicRules.ts` | 576 | Per-program JSON files + curated policy templates. (576 lines of text constants, not logic.) |
| `semanticSearch.ts` | ~146 | `search/policySearch.ts` with Cohere Rerank |

> **Key insight:** The code being replaced is orchestration glue and prompt text. The code being kept is the hard algorithmic logic (rule evaluation, DAG traversal, credit pacing, enrollment validation) that took real effort to debug and test. Starting a new repo would mean rewriting all of it for zero benefit.

---

### Implementation Phases

> **Updated:** Consolidated into 7 phases. The engine work (de-hardcoding, types, data, generalization) is merged into a single Phase 1 because the intermediate steps are not independently testable for non-CAS behavior. Comprehensive testing happens only when the engine can actually process non-CAS schools.
>
> Each phase is:
> - **Independently verifiable** — tests prove correctness after each phase
> - **Linearly progressive** — no phase requires rework of any prior phase
> - **Comprehensively tested** — no phase is considered complete without proof it works

| Phase | Name | Scope | Verifiable By | Est. |
|-------|------|-------|---------------|------|
| **1** | **Multi-School Engine** | De-hardcode CS-specific code. Add types (SchoolConfig, ProgramDeclaration, Rule extensions). Create school configs + program data files. Refactor dataLoader. Wire engine (creditCapValidator, passfailGuard, ruleEvaluator) to read SchoolConfig with CAS fallback. | 126 existing CAS/CS tests pass identically + new Stern P/F test + new Tandon residency test + new Econ BA major-agnostic test + multi-program planner test | 2-3 weeks |
| **2** | **Cross-Program + New Tools** | crossProgramAudit.ts (multi-program coordinator, double-counting). spsEnrollmentGuard.ts. checkTransferEligibility.ts. whatIfAudit.ts. I/NR/W grade handling, SAP formula fix, per-major GPA. | Multi-program student audit handles double-counting correctly. Transfer eligibility returns correct prereqs. Edge case grade profiles pass. | 1 week |
| **3** | **Planner Extensions** | Exploratory/transfer-prep planning modes. Multi-semester projection. Cross-program priority scoring. | Undeclared student gets Core-first plan. Transfer student sees prereqs + deadline warnings. | 3-5 days |
| **4** | **RAG Pipeline** | Policy document chunking + embedding. Vector store (policySearch.ts with Cohere Rerank). ragScopeFilter.ts (school/year hard-filtering, explicit cross-school override). | `search_policy("can I take courses P/F?")` returns relevant CAS P/F chunks, not Stern or Tandon. | 1-2 weeks |
| **5** | **Agent Orchestrator** | Tool definitions + registry. Agent loop (while(true) with turn limits, abort, model fallback). System prompt (25 rules). templateMatcher.ts (5-step gate, pre-loop dispatch). responseValidator.ts (invocation auditor, grounding checks). | Test conversations produce correct tool calls. FAQ queries match templates without touching LLM. | 2-3 weeks |
| **6** | **Integration + Hardening** | Wire agent to web API + streaming. Deprecate old chat/, academicRules.ts, semanticSearch.ts (replacements now exist). Fallback logging. | End-to-end conversation from web UI produces correct, validated responses. | 1 week |
| **7** | **Scale to All Majors** | Per-major JSON files in batches of 10. Per-school bulletin chunks in RAG. Ongoing. | Eval suite passes for each new major with >90% accuracy. | Ongoing (2-4 weeks/batch) |

#### Phase 1 Internal Steps

Phase 1 is the largest phase. Internally it follows this order:

```
Step A: De-hardcode CS-specific code           → existing tests pass (regression guard)
Step B: Add types (SchoolConfig, etc.)         → TypeScript compiles (type check)
        Update all test profiles (homeSchool, ProgramDeclaration format)
Step C: Create school configs + dataLoader     → dataLoader unit tests pass
Step D: Engine reads SchoolConfig              → code only, no tests yet
CHECKPOINT: Comprehensive test suite           → ALL 5 test groups pass
```

The CHECKPOINT at the end of Phase 1 runs:
1. **Regression** — all 126 existing CAS/CS tests produce identical output
2. **Major-agnostic** — new CAS Econ BA student audits correctly (proves engine isn't CS-specific)
3. **SchoolConfig-driven** — Stern P/F rules, Tandon residency model work correctly
4. **Multi-program planner** — merged audit results across programs, correct priority scoring
5. **DataLoader** — multi-file loading, backward compatibility, null for unknown schools

#### Key Design Decisions

1. **No deprecation until Phase 6.** The old `chat/`, `academicRules.ts`, `semanticSearch.ts` stay untouched through Phases 1-5. Deprecation happens only after the replacement (agent orchestrator) is working.

2. **CAS fallback everywhere.** Phase 1's engine changes always have a `if (!schoolConfig) { /* use current hardcoded CAS defaults */ }` path. This means existing tests pass without modification.

3. **Comprehensive testing, not incremental false confidence.** Phase 1's intermediate steps (types, data files) cannot be meaningfully tested for non-CAS behavior. Rather than claim "tests pass" when those tests can only verify CAS regression, we consolidate into one phase and prove correctness at the end with a comprehensive suite covering multiple schools.

---

## Appendix A: System Prompt

> **📖 Claude Code Reference for system prompt design:**
> - `coordinator/coordinatorMode.ts` L111-369 — The coordinator system prompt. Study how it defines the agent's role, available tools, workflow phases, prompt-writing rules, and example sessions. Our system prompt follows this structure.
> - `tools/AgentTool/prompt.ts` L99-113 — "Writing the prompt" section. The principle: "Brief the agent like a smart colleague who just walked into the room." "Never delegate understanding."
> - `tools/AgentTool/prompt.ts` L233-240 — "When NOT to use" section. Explicitly tells the LLM when NOT to call a tool. We adopt this for all our tools.

```
ROLE:
You are NYU Path, an AI academic adviser for NYU College of Arts & Science.
You help students understand their degree progress, plan semesters, and
navigate academic policies. You are precise, factual, and helpful.

CORE RULES (mandatory):
1. NEVER compute numbers yourself. Every number must come from a tool result.
   ALWAYS call the appropriate tool. If you catch yourself writing a number
   that didn't come from a tool result, STOP and call the tool.
2. NEVER guess course availability — call plan_semester or search_courses.
3. NEVER answer a policy question from training data. ALWAYS call
   search_policy first and cite the returned source document and section.
4. For double-major/minor questions, ALWAYS call check_overlap.
5. Before discussing CREDIT COUNTS, GPA, GRADUATION PROGRESS, or SEMESTER
   PLANNING, call at minimum: get_academic_standing → get_credit_caps.
   This does NOT apply to simple questions like prerequisites, course
   descriptions, or policy lookups — those have their own required tools.
6. For planning, call plan_semester. Do NOT manually suggest courses.

FALLBACK RULES (mandatory):
7. If a tool returns validation error (validateInput failed):
   → Read the error message — it tells you what to ask the user.
   → Ask the user for the missing information.
   → DO NOT proceed without it.
8. If a tool returns "unsupported":
   → Say: "I don't have the data for [X] yet."
   → Provide the specific NYU contact.
   → NEVER attempt to answer from your own knowledge.
9. If search_policy returns confidence < 0.3:
   → "I couldn't find a specific policy. Contact [resource]."
10. If search_policy returns confidence 0.3-0.6:
    → Cite the result, add: "I'd recommend confirming with your adviser."
11. If you need data that's missing from the profile:
    → ASK the student. Don't assume or default.

PRECISION RULES:
12. Explain reasoning. For each recommended course, state WHY.
13. If adviser approval is required, SAY SO.
14. P/F: say "won't satisfy the major requirement", not "not allowed".
15. Every policy citation: document name + section.
16. "X credits remaining" — include which tool produced that number.
17. NEVER say "all requirements met" unless run_full_audit returned
    overall status === "complete" for EVERY declared program.
18. Don't say "cannot take more than N electives" — students CAN take
    more, they just won't count toward the requirement.

PLANNING-SPECIFIC RULES:
19. BEFORE calling plan_semester, check profile for REQUIRED fields.
    If ANY are missing, ASK the student first:
    - visaStatus, declaredPrograms, completedCourses, targetGraduationTerm
    If OPTIONAL fields are missing, proceed but caveat:
    - preferences, workloadPreference, scheduleConstraints
20. AFTER plan_semester returns, check uncertainties[].
    For each: call search_policy with the suggestedPolicyQuery.
21. For EVERY course in the plan, state WHY.
22. If plan includes >16 credits, note it explicitly.
23. For multi-semester plans, caveat: "Future semesters are projections."
24. NEVER present a plan without running run_full_audit first.
25. If plan_semester returns risks[], present them AFTER the plan.
```

---

## Appendix B: Data Model

> **📖 Claude Code Reference for data type design:**
> - `Tool.ts` L158-300 — `ToolUseContext` type. Study how Claude Code passes context (abort controllers, state getters/setters, options, tracking) through every tool call. Our `ToolContext` is a simplified version.
> - `query.ts` L181-199 — `QueryParams` type. Study how immutable params (`systemPrompt`, `tools`) are separated from mutable state (`messages`, `turnCount`). We adopt this separation.

### StudentProfile (complete)

```typescript
interface StudentProfile {
  // Identity
  studentId: string;
  name: string;
  catalogYear: string;          // G40: readmitted students use readmission year
  
  // Academic programs
  declaredPrograms: DeclaredProgram[];  // majors + minors
  
  // Transcript
  completedCourses: CompletedCourse[];  // includes grades
  inProgressCourses: string[];          // current term
  
  // Exam credits
  examCredits: ExamCredit[];            // AP, IB, A-Level, dual enrollment
  
  // Computed fields (populated by engine)
  totalCredits: number;
  cumulativeGPA: number;
  homeSchoolCreditCount: number;        // G13: track home-school credits (e.g., -UA for CAS, -UY for Tandon)
  nonHomeSchoolCredits: number;          // G29: track non-home-school credits
  advancedStandingCredits: number;      // G31: track AP+IB+dual total
  
  // Student context
  visaStatus: 'F-1' | 'domestic' | 'other' | undefined;  // affects enrollment rules
  targetGraduationTerm: string | undefined;     // e.g., "Spring 2026"
  foreignLanguageExempt: boolean;               // G36
  standingLevel: 'good' | 'concern' | 'continued_concern' | 'required_leave' | undefined;  // G37
  
  // Preferences (optional)
  workloadPreference: 'light' | 'standard' | 'heavy' | undefined;
  preferences: string[] | undefined;           // interests, topics
  scheduleConstraints: ScheduleConstraint[] | undefined;
}

interface CompletedCourse {
  courseId: string;
  grade: string;           // A, A-, B+, ..., D, F, P, W, I, NR
  credits: number;
  term: string;            // e.g., "Fall 2023"
  isOnline: boolean;
  isTransfer: boolean;
  school: string;          // "CAS", "Tandon", "Stern", etc.
}

interface ExamCredit {
  examType: 'AP' | 'IB' | 'A-Level' | 'dual_enrollment';
  examName: string;        // e.g., "AP Computer Science A"
  score: number;
  creditsGranted: number;
  equivalentCourse: string | null;  // e.g., "CSCI-UA 101"
  revoked: boolean;                 // G11: revoked when student takes the course
}
```

### PlanResult (complete)

```typescript
interface PlanResult {
  courses: PlannedCourse[];
  totalCredits: number;
  risks: GraduationRisk[];
  uncertainties: PlanUncertainty[];
  missingDataCaveats: string[];
}

interface PlannedCourse {
  id: string;
  title: string;
  credits: number;
  reason: string;                     // WHY this course was chosen
  satisfiesRequirement: {
    programId: string;
    programName: string;
    ruleId: string;
    programType: 'major' | 'minor' | 'core' | 'elective';
  } | null;
  isOnline: boolean;
  courseLevel: 'undergrad' | 'grad_1000' | 'grad_2000';
}

interface PlanUncertainty {
  type: 'online_for_major' | 'non_cas_course' | 'grad_course'
      | 'department_restriction' | 'petition_may_be_needed'
      | 'cross_school_enrollment' | 'non_ua_residency_impact';
  courseId: string;
  description: string;
  suggestedPolicyQuery: string;
  severity: 'info' | 'warning' | 'blocker';
}
```

---

## Appendix C: Policy Gaps Registry (G1–G45)

| # | Gap | Classification | Implementation |
|---|-----|---------------|----------------|
| G1-G4 | Cross-program overlap | Deterministic | `crossProgramAudit.ts` — max 2 shared |
| G5-G6 | Major/Minor GPA | Deterministic | `gpaCalculator.ts` |
| G7-G8 | Residency % per program | Deterministic | Counter in audit (SchoolConfig) |
| G9 | Final credits in school | Deterministic | Credit ordering (if applicable per SchoolConfig) |
| G10 | Near-graduation flexibility | Deterministic | Credit sum (program.totalCreditsRequired - 2) |
| G11 | AP credit revocation | Deterministic | `resolveExamCredit.ts` |
| G12 | Course repeat dedup | Deterministic | Transcript filter |
| G13 | School residency credits | Deterministic | Counter (SchoolConfig.residency) |
| G14 | Core exemptions | RAG | Policy explanation |
| G15 | Repeat limits | Deterministic | Counter ≤ SchoolConfig.maxCourseRepeats |
| G16 | Overload detection | Deterministic | Credit sum vs SchoolConfig.maxCreditsPerSemester |
| G17 | Degree time limit | Deterministic | Date comparison (if SchoolConfig.timeLimitYears) |
| G18 | SAP 67% completion | Deterministic | earned/attempted |
| G19 | Independent study cap | Deterministic | Credit sum ≤ creditCaps[independent_study] (CAS: 12cr, 8/dept) |
| G20 | Online course limits | Deterministic | Counter |
| G21 | Writing proficiency | RAG | Policy explanation |
| G22 | Graduate courses | RAG | 1000/2000 level policy |
| G23-24 | Dean's List / Latin honors | RAG | Informational only |
| G25 | Study abroad credits | RAG + G58 | School-level: RAG (per-program approval). Major-level: G58 deterministic (majorResidency) |
| G26 | Summer restrictions | RAG | Narrative policy |
| G27 | Graduation credit total | Deterministic | Credit sum (per program.totalCreditsRequired) |
| G28 | Dual enrollment restrictions | RAG | Policy explanation |
| G29 | Non-home-school credit cap | Deterministic | Counter ≤ SchoolConfig.creditCaps |
| G31 | Advanced standing cap | Deterministic | Counter ≤ SchoolConfig.creditCaps |
| G32-33 | I/NR grades ≠ earned | Deterministic | Grade filter |
| G34 | W in SAP attempted | Deterministic | Formula fix |
| G35 | Per-school grade thresholds | Deterministic | SchoolConfig.gradeThresholds |
| G36 | Foreign language exemption | Flag + RAG | Boolean flag → RAG explains |
| G37 | Standing escalation levels | Flag + RAG | GPA check → RAG explains |
| G38 | Course sequencing | RAG | Per-department policies |
| G39 | P/F FL exception | Flag + RAG | One `if` → RAG explains |
| G40 | Catalog year (readmitted) | Flag + RAG | Route to correct JSON |
| G41 | SPS course exception | Flag + RAG | Allowlist in non-home-school tracker |
| G42 | Placement ≠ credit | RAG | FAQ answer |
| G43 | Transfer grade ≥ C | RAG | FAQ answer |
| G44 | 10-year credit expiry | RAG | Rare edge case |
| G45 | Dismissal at <50% | RAG | SAP already flags |
| **G46** | **Per-school P/F rules** | **Deterministic** | `passfailGuard.ts` reads `SchoolConfig.passFail` — career/term limits, canElect, countsForMajor |
| **G47** | **SPS enrollment blocker** | **Deterministic** | `spsEnrollmentGuard.ts` — total ban (Stern/Tandon) vs partial allowlist (CAS/Tisch) |
| **G48** | **Asymmetric double-counting** | **Deterministic** | `crossProgramAudit.ts` uses `SchoolConfig.doubleCounting` — M-M vs M-m limits, Stern default=0 |
| **G49** | **Transfer credit limits** | **Deterministic** | `creditCapValidator.ts` — 32cr first-year cap (NYU-wide), per-school transfer max (Steinhardt: 72, SPS: 80) |
| **G50** | **Advanced standing eligibility** | **Flag + RAG** | `SchoolConfig.acceptsTransferCredit` — flag if school not in official list |
| **G51** | **Stern Global Experience** | **Milestone** | `stern_business_core.json` → `global_experience` milestone rule (par11.3i) |
| **G52** | **Stern LAS elective minimum** | **Deterministic** | `courseFilter.suffix_allowlist` in rule evaluator (par11.3j) — NY State requirement |
| **G53** | **Tiered overload GPA** | **Deterministic** | `overloadRequirements[]` array — Stern first-year 3.5 vs continuing 3.0+32cr |
| **G54** | **Dean's List per school** | **Config + RAG** | `SchoolConfig.deansListThreshold` — Steinhardt 3.7/12cr/term vs Tisch 3.65/28pts/year |
| **G55** | **LS forced-exit lifecycle** | **Deterministic** | `SchoolConfig.lifecycle` — dual-audit mode, transition warnings at semester 6, dismissal at semester 8 |
| **G56** | **Concentration program type** | **Deterministic** | `ProgramType = "concentration"` for Stern — own GPA calc, own double-counting rules |
| **G57** | **Departmental honors tracks** | **Deterministic** | `tracks[].gpaGate` + `trackRequirementsMode: "additive"` — CS adds 12cr, Econ adds thesis sequence |
| **G58** | **Per-major study abroad residency** | **Deterministic** | `program.majorResidency` — CS: ≥50% of CSCI-UA/MATH-UA must be NYU-NY (not NYUAD/NYUSH) |
| **G59** | **Nursing P/F 25% + exclusion categories** | **Deterministic** | `passfailGuard.ts` with `careerLimitType: "percent_of_program"` — excludes CORE-UA, science, nursing prereqs/sequence, PSYCH-UA 1 |
| **G60** | **Tandon internship 6-credit cap** | **Deterministic** | `creditCapValidator.ts` — `creditCaps[type='internship']` with `gpaMinimum: 2.5`, no prior incompletes |
| **G61** | **CAS SPS internship/independent-study ban** | **Deterministic** | `spsEnrollmentGuard.ts` — even for allowed SPS prefixes, internship/independent-study courses are blocked |
| **G62** | **Steinhardt dept-discretionary double-counting** | **Config + RAG** | `doubleCounting.overrideByProgram` + `requiresDepartmentApproval: true` — some depts allow 0, some 1 |

---

## Appendix D: Formal Correctness Specification

> **Purpose:** This specification defines what a "correct" response means, measurably. It is the basis for automated evaluation scoring and the standard against which the system's reliability is assessed.

For any response **R** to user query **Q** given student profile **P** and tool results **T**:

### D.1 Grounding (no fabrication)

Every factual claim in R must be traceable to one of:

| Claim Type | Required Source | Violation Example |
|------------|----------------|-------------------|
| A specific number (GPA, credits, count) | A deterministic tool result in T | "You have 3.5 GPA" when no tool returned this |
| A course recommendation | `plan_semester` or `search_courses` result in T | "Take CSCI-UA 480" when no tool suggested it |
| A policy statement | A `search_policy` result in T with confidence ≥ 0.3 | "P/F is not allowed" without policy source |
| A deadline or date | A `search_policy` or curated template result | "Withdraw by Nov 15" from training data |

**Scoring:** Each claim is binary (grounded / ungrounded). Response grounding score = grounded claims / total claims.

### D.2 Completeness (no harmful omissions)

R must address ALL of the following that are relevant to Q + P:

| Condition | Required Mention | When Relevant |
|-----------|-----------------|---------------|
| Direct answer to Q | Always | Always |
| F-1 enrollment constraints | If P.visaStatus === 'F-1' | Q touches course load, credits, or enrollment |
| Non-home-school credit cap warning | If approaching SchoolConfig cap (≥75%) | Q touches credit counts or course selection |
| Cross-program overlap rules | If P.declaredPrograms.length > 1 | Q touches requirements or planning |
| Prerequisite dependencies | If recommended courses have unmet prereqs | Q asks for course recommendations |
| Adviser approval requirement | If action requires department/adviser sign-off | Q asks about overload, petition, or exception |
| SAP / academic standing risk | If P.standingLevel !== 'good' | Q touches planning or progress |
| Graduation timeline impact | If P.totalCredits > (totalRequired - 16) | Q touches planning |
| **SPS enrollment blocker** | If course is -UC/-CE AND SchoolConfig.spsPolicy.allowed === false | Q asks about SPS course or course is recommended |
| **P/F eligibility warning** | If P/F is requested AND SchoolConfig.passFail.canElect === false | Q asks about P/F for any course |
| **P/F major restriction** | If P/F is requested for a major/concentration course AND !passFail.countsForMajor | Q asks about P/F for a course counting toward major |
| **LS transition deadline** | If P.homeSchool === "liberal_studies" AND lifecycle.semestersCompleted ≥ 4 | Any query from an LS student |
| **Stern double-count prohibition** | If P.homeSchool === "stern" AND courses might overlap | Q touches course selection with concentration implications |

**Scoring:** Each applicable item is binary (mentioned / omitted). Completeness score = mentioned / applicable.

### D.3 Uncertainty Transparency (no overconfidence)

| Scenario | Required Behavior |
|----------|-------------------|
| RAG confidence < 0.3 | R must include: "I couldn't find a specific policy. Contact [resource]." |
| RAG confidence 0.3-0.6 | R must include a caveat: "I'd recommend confirming with your adviser." |
| Question outside system scope | R must say: "I don't have data for X yet." + provide contact |
| Plan includes uncertainties | R must list all uncertainties from `plan_semester` result |
| Future semester projections | R must caveat: "Future semesters are projections that may change." |

**Scoring:** Each applicable scenario is binary (properly caveated / overconfident).

### D.4 Non-fabrication (no hallucinated entities)

R must NOT contain:

| Violation | Detection Method |
|-----------|------------------|
| A course ID not in the catalog | Cross-reference against courses.json |
| A program name not in the system | Cross-reference against programs/ directory |
| A contact email that doesn't exist | Check against known NYU contacts |
| A policy section that doesn't exist | Cross-reference against policy chunks |
| A requirement that isn't in the program JSON | Cross-reference against program rules |

**Scoring:** Binary per response (contains fabrication / clean).

### D.5 Composite Scoring

```
Response Correctness Score = 
  0.30 × Grounding
  + 0.35 × Completeness      ← Weighted highest: omission is the #1 risk
  + 0.20 × Uncertainty Transparency
  + 0.15 × Non-fabrication
```

**Thresholds:**
- ≥ 0.90: Production-ready
- 0.75-0.89: Acceptable with monitoring
- < 0.75: Requires investigation and fixes

**Evaluation cadence:** Weekly batch of 50 golden QA pairs scored against this spec. Results tracked over time to detect drift.

---

> **This document is the single source of truth for all NYU Path implementation work.**  
> Place: `/NYU Path/ARCHITECTURE.md` in the repo root.  
> All phase work should reference this document.
