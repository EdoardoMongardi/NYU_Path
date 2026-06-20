// ============================================================
// sectionReplanWiring.test.ts — Phase 38 live-data fix (review #1/#4)
// ============================================================
// makeFoseOpenCheck (the production isOfferedAndOpen for the rung-1
// within-term swap finder) must treat live "A" (offered, seat-unknown)
// rows as usable — a bare O||W check rejected every live section and
// silently killed rung-1.
// ============================================================

import { describe, it, expect } from "vitest";
import { makeFoseOpenCheck } from "../../src/agent/sectionMaterialization/sectionReplanWiring.js";

describe("makeFoseOpenCheck — A-status (live reality)", () => {
    it("treats a live 'A' (offered, seat-unknown) section as offered/usable", async () => {
        const searchFn = async (_t: string, kw: string) =>
            kw === "CSCI-UA 470" ? [{ code: "CSCI-UA 470", stat: "A" }] : [];
        expect(await makeFoseOpenCheck(searchFn)("CSCI-UA 470", "1268")).toBe(true);
    });

    it("still counts O and W as usable", async () => {
        const sf = (st: string) => async () => [{ code: "X", stat: st }];
        expect(await makeFoseOpenCheck(sf("O"))("X", "1268")).toBe(true);
        expect(await makeFoseOpenCheck(sf("W"))("X", "1268")).toBe(true);
    });

    it("excludes closed (C) sections", async () => {
        const searchFn = async () => [{ code: "X", stat: "C" }];
        expect(await makeFoseOpenCheck(searchFn)("X", "1268")).toBe(false);
    });

    it("returns false when the course isn't offered (no matching row)", async () => {
        const searchFn = async () => [];
        expect(await makeFoseOpenCheck(searchFn)("X", "1268")).toBe(false);
    });
});
