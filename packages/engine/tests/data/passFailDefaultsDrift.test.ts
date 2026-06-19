/**
 * Drift-guard: the client-safe inline record in
 * `packages/engine/src/data/passFailDefaults.ts` must stay byte-for-byte
 * identical to the `passFail` block in each school's
 * `data/schools/<id>.json`.
 *
 * If you update a school's JSON, update passFailDefaults.ts to match.
 * If you add a school with a passFail block, add it to SCHOOL_IDS below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { passFailForSchool } from "../../src/data/passFailDefaults";

/** All 11 canonical school ids that have a passFail block in data/schools/ */
const SCHOOL_IDS = [
    "cas",
    "gallatin",
    "liberal_studies",
    "nursing",
    "nyuad",
    "shanghai",
    "sps",
    "steinhardt",
    "stern",
    "tandon",
    "tisch",
] as const;

const DIR = join(__dirname, "../../../../data/schools");

function readJsonPassFail(id: string): object | undefined {
    const raw = JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8"));
    return raw.passFail as object | undefined;
}

describe("passFailDefaults drift-guard — inline record vs data/schools/*.json", () => {
    it.each(SCHOOL_IDS)(
        "%s — passFailForSchool() deep-equals data/schools/<id>.json#passFail",
        (id) => {
            const jsonPf = readJsonPassFail(id);
            const inlinePf = passFailForSchool(id);

            // Both JSON and inline must agree on presence
            if (jsonPf === undefined) {
                // If JSON has no passFail block, the inline record should also be absent
                expect(inlinePf).toBeUndefined();
            } else {
                // If JSON has a passFail block, inline must match it exactly
                expect(inlinePf).toBeDefined();
                expect(inlinePf).toEqual(jsonPf);
            }
        },
    );

    it("covers ALL 11 expected school ids (missing-school guard)", () => {
        for (const id of SCHOOL_IDS) {
            const jsonPf = readJsonPassFail(id);
            expect(
                jsonPf,
                `data/schools/${id}.json must have a passFail block`,
            ).toBeDefined();
            expect(
                passFailForSchool(id),
                `passFailForSchool("${id}") must return a value — add it to passFailDefaults.ts`,
            ).toBeDefined();
        }
        // Ensure no school was silently dropped from SCHOOL_IDS
        expect(SCHOOL_IDS).toHaveLength(11);
    });
});
