#!/usr/bin/env -S npx tsx
/**
 * Phase 15 Task 0 — One-off recorder for FOSE fixtures.
 *
 * Run: pnpm tsx tools/fose-recorder/recordFixtures.ts
 *
 * Hits live FOSE for ~28 representative queries; saves each raw
 * response as JSON under packages/engine/tests/fixtures/fose/.
 * Used by parseMeetingTimes.ts + materialize.ts as ground-truth for
 * test fixtures — without this we'd be designing the parser blind.
 *
 * =============================================================
 * ACTUAL observed field formats (documented after first run 2026-05-03):
 *
 * NOTE: The FOSE API does NOT return an `hours` field. The actual fields are:
 *   - `meets`        : human-readable string (the primary text to display)
 *   - `meetingTimes` : JSON string array [{meet_day, start_time, end_time}]
 *                      meet_day: "0"=Mon, "1"=Tue, "2"=Wed, "3"=Thu, "4"=Fri
 *                      start_time / end_time: 24-hour "HHMM" e.g. "930", "1215"
 *
 * `meets` field observed variants:
 *
 * 1. Standard timed — day abbreviation(s) + time range:
 *      "TR 8-9:15a"           (T=Tue, R=Thu)
 *      "MW 9:30-10:45a"       (M=Mon, W=Wed)
 *      "MTWR 11:10a-1:15p"    (Mon-Thu daily — summer intensive)
 *      "TRF 9:30-10:45a"      (T=Tue, R=Thu, F=Fri)
 *      Single-day: "M 8-9:15a", "T 4-6:20p", "W 12:30-1:20p", "R 9:30-10:45a", "F 11a-12:15p"
 *
 * 2. Multi-session (semicolon separator):
 *      "TR 8-9:15a; F 2-4p"
 *      "MW 12:30-1:45p; F 2-4p"
 *      The `meetingTimes` array covers all sessions across the semicolons.
 *
 * 3. Special / unscheduled:
 *      "Does Not Meet"        (section record with no scheduled meeting)
 *      null / absent          (field absent from API response — treat as no time)
 *
 * 4. Lab+lecture composite rows:
 *      Each row is its own FoseSearchResult (distinct CRN + schd field).
 *      `schd` values: "LEC" (lecture), "LAB" (lab), "RCT" (recitation).
 *      e.g. lecture: "MW 11a-12:20p"   schd="LEC"
 *           lab:     "F 8-10:50a"      schd="LAB"
 *           recit:   "F 11a-12:15p"    schd="RCT"
 *
 * Time shorthand in `meets`:
 *      "11a"    = 11:00am
 *      "12:30p" = 12:30pm
 *      "2-3:15p" = 2:00pm – 3:15pm (start hour has no minutes when on the hour)
 *      "8-9:15a" = 8:00am – 9:15am
 *
 * `stat` values observed: only "A" seen in Fall 2026 fixtures
 * (may vary once registration opens — "O"=open, "C"=closed, "W"=waitlist are
 *  documented in FoseSearchResult but not yet observed in this corpus).
 *
 * These variants are the spec contract for Task 1's parseMeetingTimes.ts.
 * =============================================================
 */

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchCourses, generateTermCode } from "../../packages/engine/src/api/nyuClassSearch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../packages/engine/tests/fixtures/fose");

interface Query {
    keyword: string;
    year: number;
    term: "spring" | "summer" | "fall";
    label: string; // file-safe label, e.g. "csci-ua-101_2026-fall"
}

// Query matrix — span schools, formats, term states.
const QUERIES: Query[] = [
    // --- Current/active term (most data expected) ---
    { keyword: "CSCI-UA 101",  year: 2026, term: "fall",   label: "csci-ua-101_2026-fall" },
    { keyword: "CSCI-UA 421",  year: 2027, term: "spring", label: "csci-ua-421_2027-spring" },
    { keyword: "MATH-UA 121",  year: 2026, term: "fall",   label: "math-ua-121_2026-fall" },
    { keyword: "BIOL-UA 11",   year: 2026, term: "fall",   label: "biol-ua-11_2026-fall" },     // lab+lecture
    { keyword: "FREN-UA 1",    year: 2026, term: "fall",   label: "fren-ua-1_2026-fall" },       // language
    { keyword: "ECON-UA 1",    year: 2026, term: "fall",   label: "econ-ua-1_2026-fall" },
    { keyword: "CORE-UA 400",  year: 2026, term: "fall",   label: "core-ua-400_2026-fall" },
    { keyword: "HIST-UA 1",    year: 2026, term: "fall",   label: "hist-ua-1_2026-fall" },
    { keyword: "MUS-UA 1",     year: 2026, term: "fall",   label: "mus-ua-1_2026-fall" },
    { keyword: "STERN-UB 1",   year: 2026, term: "fall",   label: "stern-ub-1_2026-fall" },
    { keyword: "MGMT-UB 1",    year: 2026, term: "fall",   label: "mgmt-ub-1_2026-fall" },
    { keyword: "FIN-UB 1",     year: 2026, term: "fall",   label: "fin-ub-1_2026-fall" },
    { keyword: "TISCH-UT",     year: 2026, term: "fall",   label: "tisch-ut_2026-fall" },         // department-wide
    { keyword: "MUED-UE",      year: 2026, term: "fall",   label: "mued-ue_2026-fall" },
    { keyword: "GALLATIN-UF",  year: 2026, term: "fall",   label: "gallatin-uf_2026-fall" },
    { keyword: "CSCI-UY 1114", year: 2026, term: "fall",   label: "csci-uy-1114_2026-fall" },    // Tandon
    { keyword: "CSCI-SHU",     year: 2026, term: "fall",   label: "csci-shu_2026-fall" },         // Shanghai
    { keyword: "CSCI-UH",      year: 2026, term: "fall",   label: "csci-uh_2026-fall" },          // Abu Dhabi

    // --- Partial / pre-registration term (course list but maybe no times) ---
    { keyword: "CSCI-UA 101",  year: 2027, term: "spring", label: "csci-ua-101_2027-spring" },
    { keyword: "MATH-UA 121",  year: 2027, term: "spring", label: "math-ua-121_2027-spring" },

    // --- Far-future term (expected empty) ---
    { keyword: "CSCI-UA 101",  year: 2028, term: "fall",   label: "csci-ua-101_2028-fall" },
    { keyword: "MATH-UA 121",  year: 2028, term: "spring", label: "math-ua-121_2028-spring" },

    // --- Summer + J-term (sparse data — most dept don't run them) ---
    { keyword: "CSCI-UA 101",  year: 2026, term: "summer", label: "csci-ua-101_2026-summer" },
    { keyword: "MATH-UA 121",  year: 2026, term: "summer", label: "math-ua-121_2026-summer" },

    // --- Multi-meeting / lab patterns ---
    { keyword: "CHEM-UA 125",  year: 2026, term: "fall",   label: "chem-ua-125_2026-fall" },     // chem with lab
    { keyword: "PHYS-UA 11",   year: 2026, term: "fall",   label: "phys-ua-11_2026-fall" },      // physics with lab

    // --- Edge case: empty result expected for non-existent course ---
    { keyword: "ZZZZZ-UA 9999", year: 2026, term: "fall",  label: "nonexistent_2026-fall" },
];

async function main() {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    let success = 0, failed = 0;

    for (const q of QUERIES) {
        const termCode = generateTermCode(q.year, q.term);
        try {
            const results = await searchCourses(termCode, q.keyword);
            const fixture = {
                query: q,
                termCode,
                recordedAt: new Date().toISOString(),
                resultCount: results.length,
                results,
            };
            const outPath = join(FIXTURE_DIR, `${q.label}.json`);
            fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
            console.log(`  ✓ ${q.label} (${results.length} sections)`);
            success++;
        } catch (e) {
            console.error(`  ✗ ${q.label}: ${e instanceof Error ? e.message : e}`);
            failed++;
        }
        // Be polite to FOSE.
        await new Promise(r => setTimeout(r, 250));
    }

    console.log(`\nSuccess: ${success}, Failed: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
