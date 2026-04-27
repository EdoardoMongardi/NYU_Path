# T2 Program Extraction Prompt (Phase 6.1 WS8)

You are extracting NYU undergraduate program requirements from a bulletin
markdown file into a structured JSON shape the NYU Path engine can audit.

## Output schema (strict)

Return ONLY a JSON object matching this shape — no prose, no markdown
fences, no commentary:

```jsonc
{
  "_meta": {
    "catalogYear": "2025-2026",
    "sourceUrl": "<the bulletin URL the markdown came from>",
    "lastVerified": "<today's date in YYYY-MM-DD>",
    "sourceHash": "sha256:<hash of the bulletin file>",
    "extractedBy": "llm-assisted",
    "verifiedBy": "spot-check",
    "sourceRef": { "anchor": "program-requirements", "pdfPage": null }
  },
  "_provenance": [
    {
      "path": "rules[<ruleId>]",
      "claim": "<verbatim or near-verbatim phrase from the bulletin>",
      "bulletinSection": "<heading the claim came from>",
      "sourceLine": <number>
    }
    // ... one entry per rule, plus one for totalCreditsRequired
  ],
  "_notes": [
    "<any rule you couldn't fully encode — e.g., cross-rule constraints>"
  ],
  "programId": "<school>_<slug>_<degree>",
  "name": "<official program name>",
  "catalogYear": "2025-2026",
  "school": "<CAS|Stern|Tandon|...>",
  "department": "<department name>",
  "totalCreditsRequired": <integer; degree total, NOT major-only>,
  "rules": [
    // Each rule:
    //   { "ruleId": "...", "label": "...", "type": "must_take" | "choose_n" | "min_credits" | "min_level",
    //     "doubleCountPolicy": "disallow" | "allow", "catalogYearRange": ["2018", "2030"],
    //     ... type-specific fields ... }
  ]
}
```

Rule types:

| type | shape | use when |
|---|---|---|
| `must_take` | `{ courses: ["DEPT-XX 123"] }` | Single specific course |
| `choose_n` | `{ n: 1, fromPool: ["DEPT-XX 1", "DEPT-XX 2"] }` | One of a small enumerated set |
| `min_credits` | `{ minCredits: 12, fromPool: ["DEPT-XX *"] }` | Credit-count bucket |
| `min_level` | `{ atLeast: 2, level: 300, fromPool: [...] }` | "At least 2 at 300-level" |

## Rules of engagement

1. **Cite or skip.** Every rule must have a corresponding `_provenance` entry whose `claim` is verbatim (or near-verbatim) text from the bulletin. If you can't cite, don't encode.
2. **Major-only credits.** `totalCreditsRequired` is the **degree total** (typically 128). Note the major-only credit count in `_provenance` separately. Do NOT confuse the two.
3. **Pool wildcards.** `"PHIL-UA *"` matches all PHIL-UA courses. Use this for open electives. The engine's match logic handles wildcards.
4. **Cross-rule constraints go in `_notes`**, not into rule shapes the schema doesn't support.
5. **Sample plans of study, learning outcomes, and "policies" sections are informational — do not encode them as rules.**
6. **CAS Core / GenEd requirements live in `cas_core.json`, NOT in per-major files.** Do not encode them.

## Output

Return the JSON. No prose. No fences. The Zod validator at
`packages/engine/src/provenance/configSchema.ts:programBodySchema`
must accept the output verbatim.
