# NYU Path — Cohort A pilot user guide

Welcome! You're one of ~10 NYU undergrads piloting NYU Path. This is a 5-minute read on what the tool does, what it doesn't, and how to get the most out of it without getting burned.

## What NYU Path is

A chatbot that wraps your **Albert Degree Progress Report (DPR)** + the **NYU bulletin** + the **live class catalog (FOSE)** so you can ask academic questions in plain English. Think of it as Albert + the bulletin + an Excel-style course planner, but talked to instead of clicked through.

## What it isn't

- **Not your academic adviser.** It's an AI tool. Final decisions about your degree, transfers, drops, and course registration belong with your CAS / Tisch / Tandon / etc. adviser. NYU Path tells you what your DPR says; it cannot make commitments to you on NYU's behalf.
- **Not connected to Albert.** It can't see your account, can't enroll you in classes, can't change your declared major, can't file forms. It only sees the PDF you upload.
- **Not an official NYU service.** It's a personal-project tool built by an NYU student (Edoardo). NYU IT didn't sanction it. If you're uncomfortable sharing your DPR with a non-official tool, that's a legitimate decision — don't use it.

## What you upload

**One file: your Degree Progress Report (DPR), as a PDF.**

How to get it:

1. Log into Albert at [shibboleth.nyu.edu](https://shibboleth.nyu.edu) → Student Center.
2. Click **Academics** tab → under **Planning Tools** → **Degree Progress Report**.
3. A new window opens with your DPR (multi-page report).
4. In that window: **File → Print → Save as PDF** (Chrome / Safari / Firefox all support this).
5. Drag the saved PDF onto NYU Path's onboarding screen.

That's the entire upload. ~5 clicks. Re-upload whenever your state changes (new courses registered, declared major change, etc.).

You can also upload an **unofficial transcript** as a fallback if the DPR isn't loading for you. Same idea, slightly less data.

## What happens to your data

Read [PRIVACY.md](../PRIVACY.md) for the full version. The 30-second summary:

- **The PDF is processed in memory and discarded.** Never written to disk, never stored in any database.
- **The parsed structured form lives in your browser only.** Closes when you close the tab.
- **No cross-session memory in cohort A.** Each chat starts fresh — we do not persist your conversations on the server. The engine has a session-summary mechanism but it isn't wired in until W12 (when real auth ships). If you want to share context across sessions, re-upload your DPR each time and re-state the question.
- **A per-browser anonymous id** lives in your browser's localStorage at the key `nyupath:client-id`. It exists only to keep your daily 30-message rate-limit bucket separate from other students. You can clear it any time via DevTools.
- **No third-party sharing of the raw PDF.** OpenAI / Anthropic / Cohere see only the chat content, not the DPR file.
- **No NYU credentials handled.** You log into Albert in your own browser; we never touch your password.

## How to ask good questions

Three tiers, by reliability:

### Tier 1 — Deterministic (high confidence)

Questions that read directly from your DPR. NYU Path's answers here come from NYU's pre-computed audit and are as reliable as the DPR itself.

- "What's my cumulative GPA?"
- "How many credits do I have?"
- "What requirements am I still missing for my major?"
- "Have I met the CAS residency requirement?"
- "How many P/F credits have I used?"
- "Am I on track to graduate this spring?"

### Tier 2 — Composed (high confidence with caveats)

Questions that combine the DPR with the bulletin or live class data. Mostly reliable, but verify before acting on close calls.

- "Plan my next semester so I make progress on my major."
- "What courses can I take this fall to satisfy my missing CORE requirement?"
- "Is CSCI-UA 480 open this fall?"
- "What's the deadline to drop a class with a W?"

### Tier 3 — Estimates (treat as starting point only)

Questions about hypothetical scenarios where NYU Path doesn't have rigorous rules. The tool will tell you it's an estimate and direct you to verify with an adviser.

- "What if I switched my major to Stern Finance?"
- "Could I add a Math minor without delaying graduation?"
- "What if I transferred to Tandon?"

For Tier 3 answers, NYU Path will include a non-removable disclaimer: *"This estimate is based on AI-extracted requirements from NYU's bulletin. Verify with an academic adviser before applying for an internal transfer or program change."* Take that disclaimer seriously — it means we're not 100% sure.

## What to watch out for

- **A persistent yellow banner** at the top of the chat reminds you: *"AI advising assistant. Not a substitute for an academic adviser."* That's not boilerplate — it means it.
- **The AI is forbidden from inventing numbers.** If it tells you your GPA is 3.402 or you've used 14 outside-CAS credits, those numbers came directly from the DPR you uploaded — no synthesis. The system has a validator that rejects replies that try to make up numbers.
- **30 messages per day per student** soft cap. This is mostly a cost guard for the pilot; you'll hit a friendly "come back tomorrow" message if you blow past it. If you have an urgent question and you're capped, email the operator.
- **The tool can be wrong.** It's an LLM. It can misread your question, route to the wrong tool, or fail to surface a relevant caveat. Always double-check audits and plans against your DPR directly before acting.

## How to give feedback

- **Bugs / wrong answers** — screenshot the conversation and email Edoardo at edoardo.mongardi18@gmail.com. Include the question you asked + what the tool said + what you expected.
- **Feature requests** — same channel. Cohort A is small enough that I can directly act on requests.
- **Privacy concerns** — same channel. The honest answer for cohort A is "no per-student data is held server-side" — but if anything in PRIVACY.md surprises you, please email and I'll explain what's actually happening end-to-end.

## Cohort A timeline

- **Week 1**: onboarding + smoke testing. Operator-led; expect bugs. Use loosely.
- **Weeks 2-4**: regular use. Treat it as a study aid alongside your usual adviser conversations.
- **Week 4 retrospective**: short survey + interview. Your input shapes whether the tool is worth scaling to cohort B.

Thanks for piloting. The tool is genuinely useful or genuinely not — your feedback is what tells us which.
