# Phase 10 Stage 4 — Bake-off comparison
Generated: 2026-04-29T23:03:31.532Z

## Headline numbers

| Method | Section A | Section B | Overall | Retries |
|---|---:|---:|---:|---:|
| BASELINE (pre-Phase-10) | 50% | 60% | 54% | — |
| Method A v1 (envelope only) | 44% | 70% | 54% | — |
| Method A v2 (envelope + anti-fab guard) | 56% | 80% | 65% | — |
| Method B (envelope + reviewer+retry) | 56% | 80% | 65% | 0 |

**Strict pass criterion:** auto-grade = 1.0 AND judge composite ≥ 4.0.

## Soft pass rate (auto ≥ 0.5 AND judge ≥ 3.5)

Strict 4.0 judge bar can mask real improvements when answers are correct but the judge dings phrasing or structure. The soft bar shows the architectural delta more clearly.

| Method | Section A soft | Section B soft | Overall soft |
|---|---:|---:|---:|
| BASELINE (pre-Phase-10) | 63% | 60% | 62% |
| Method A v1 (envelope only) | 44% | 70% | 54% |
| Method A v2 (envelope + anti-fab guard) | 56% | 80% | 65% |
| Method B (envelope + reviewer+retry) | 56% | 80% | 65% |

## Mean judge composite (1-5 scale)

| Method | Section A judge avg | Section B judge avg | Overall judge avg |
|---|---:|---:|---:|
| BASELINE (pre-Phase-10) | 3.88 | 3.95 | 3.90 |
| Method A v1 (envelope only) | 3.56 | 4.03 | 3.74 |
| Method A v2 (envelope + anti-fab guard) | 3.77 | 4.28 | 3.96 |
| Method B (envelope + reviewer+retry) | 4.02 | 4.50 | 4.20 |

## Per-case verdicts (✅ pass / ❌ fail)

| ID | BASELINE B | Method v1 | Method v2 | Method B | Question |
|---|---|---|---|---|---|
| P10_A01 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | What's my current GPA, and am I in good standing? |
| P10_A02 | ❌ 2.5 | ❌ 2.8 | ❌ 2.3 | ❌ 2.3 | Which requirements have I not met yet? |
| P10_A03 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | Does CORE-UA 700 satisfy Texts and Ideas? |
| P10_A04 | ❌ 3.5 | ❌ 2.8 | ❌ 2.3 | ❌ 2.8 | Plan my Spring 2027 semester. |
| P10_A05 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | How many P/F credits have I used? Can I use P/F for my major? |
| P10_A06 | ✅ 5.0 | ❌ 2.5 | ❌ 2.8 | ✅ 5.0 | What grade do I need in MATH-UA 121 for the joint Math/CS major? |
| P10_A07 | ✅ 5.0 | ❌ 2.3 | ✅ 5.0 | ✅ 5.0 | What courses am I currently registered for? |
| P10_A08 | ❌ 2.8 | ❌ 2.5 | ❌ 2.8 | ❌ 2.8 | Can I switch from CAS to Stern Finance now? |
| P10_A09 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | Have I met the residency requirement? |
| P10_A10 | ✅ 5.0 | ✅ 5.0 | ✅ 4.5 | ✅ 5.0 | What's the deadline to drop a class with a W? |
| P10_A11 | ❌ 3.0 | ❌ 2.8 | ❌ 3.3 | ✅ 5.0 | How many credits do I need as an F-1 student per semester? |
| P10_A12 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | What's the maximum P/F I can take per semester? |
| P10_A13 | ❌ 2.3 | ✅ 4.3 | ❌ 2.3 | ❌ 2.5 | Am I on track to graduate Spring 2027? |
| P10_A14 | ❌ 1.8 | ❌ 2.0 | ❌ 1.8 | ❌ 2.8 | What courses count for the Math/CS joint major's CS required course? |
| P10_A15 | ❌ 4.0 | ❌ 2.5 | ✅ 4.5 | ❌ 3.3 | Can I count a Tandon CS course toward my CAS CS major? |
| P10_A16 | ❌ 2.3 | ❌ 2.8 | ✅ 4.0 | ❌ 3.0 | What if I dropped the math half of my major and switched to CS only? |
| P10_B01 | ❌ 3.0 | ✅ 4.0 | ✅ 5.0 | ✅ 5.0 | Does CORE-UA 800 satisfy Societies and the Social Sciences? |
| P10_B02 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | Can I use P/F for a CS minor course? |
| P10_B03 | ❌ 2.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | I'm thinking of a triple minor: Math, CS, and Philosophy. Is that allowed? |
| P10_B04 | ❌ 2.5 | ❌ 2.0 | ❌ 2.3 | ❌ 2.3 | Suggest 2 advanced CS electives I haven't taken that fit my joint major. |
| P10_B05 | ❌ 2.8 | ❌ 2.3 | ✅ 4.3 | ❌ 2.8 | Is 22 credits in one semester allowed? |
| P10_B06 | ✅ 4.3 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | If I take CSCI-UA 480 P/F, does it satisfy the upper-division CS elective for my |
| P10_B07 | ✅ 5.0 | ✅ 4.8 | ✅ 5.0 | ✅ 5.0 | What does the bulletin say about CORE-UA 999? |
| P10_B08 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | Have I used my outside-CAS credits cap? How much room is left? |
| P10_B09 | ✅ 5.0 | ❌ 2.3 | ❌ 1.3 | ✅ 5.0 | Can you sign me up for CSCI-UA 421 in Albert? |
| P10_B10 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | ✅ 5.0 | Whats the c-or-better rule and when did NYU adopt it? |

## Improvements (baseline → latest)

- **P10_A11** (A/POLICY): How many credits do I need as an F-1 student per semester?
- **P10_B01** (B/POLICY): Does CORE-UA 800 satisfy Societies and the Social Sciences?
- **P10_B03** (B/WHATIF): I'm thinking of a triple minor: Math, CS, and Philosophy. Is that allowed?

## Regressions (baseline → latest)

None.
