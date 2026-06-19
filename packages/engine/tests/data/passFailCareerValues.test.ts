import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../data/schools");
function pf(id: string) { return JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")).passFail; }

describe("per-school P/F career-limit values (bulletin-sourced)", () => {
    it.each([
        ["cas", 32], ["tisch", 32], ["liberal_studies", 16], ["sps", 16],
        ["stern", 4], ["gallatin", 4], ["nyuad", 3],
        ["steinhardt", 25], ["nursing", 25],
    ])("%s has careerLimitValue %i", (id, v) => {
        expect(pf(id).careerLimitValue).toBe(v);
        expect(typeof pf(id).careerLimitSourceRef).toBe("string");
    });
    it.each([["tandon"], ["shanghai"]])("%s has null careerLimitValue (no sourced cap → hedge)", (id) => {
        expect(pf(id).careerLimitValue).toBeNull();
    });
    it("tandon cannot elect P/F", () => { expect(pf("tandon").canElect).toBe(false); });
});
