import { describe, it, expect } from "vitest";
import {
    placePoolSlot,
    promotePoolSlotToConcrete,
    type PlacePoolSlotArgs,
    type PromotePoolSlotArgs,
} from "../../src/agent/forwardSchedule/poolBinding.js";
import type { PoolBinding } from "@nyupath/shared";

// --- Fixture ---

const poolBinding: PoolBinding = {
    poolId: "CS_ELECTIVE_POOL",
    candidates: ["CSCI-UA 480", "CSCI-UA 490", "CSCI-UA 476"],
    satisfiesRule: "CS_ELECTIVE_CHOOSE_2",
};

// 1. placePoolSlot produces a RequirementPoolSlot with correct shape
describe("placePoolSlot — produces unbound RequirementPoolSlot", () => {
    it("returns kind=requirement-pool, bindingState=unbound, bound=undefined, candidates from poolBinding", () => {
        const args: PlacePoolSlotArgs = {
            poolBinding,
        };
        const slot = placePoolSlot(args);
        expect(slot.kind).toBe("requirement-pool");
        expect(slot.bindingState).toBe("unbound");
        expect(slot.bound).toBeUndefined();
        expect(slot.candidates).toEqual(poolBinding.candidates);
        expect(slot.ruleId).toBe(poolBinding.satisfiesRule);
    });
});

// 2. promotePoolSlotToConcrete succeeds when chosenCourseId is in candidates
describe("promotePoolSlotToConcrete — success: courseId in candidates", () => {
    it("returns success=true and a bound slot when the chosen course is a valid candidate", () => {
        const args: PlacePoolSlotArgs = {
            poolBinding,
        };
        const placeholder = placePoolSlot(args);

        const promoteArgs: PromotePoolSlotArgs = {
            placeholder,
            chosenCourseId: "CSCI-UA 480",
        };
        const result = promotePoolSlotToConcrete(promoteArgs);
        expect(result.success).toBe(true);
        expect(result.bound).toBeDefined();
        expect(result.bound!.bound).toBe("CSCI-UA 480");
        expect(result.rejectedBecause).toBeUndefined();
    });
});

// 3. promotePoolSlotToConcrete rejects when chosenCourseId NOT in candidates
describe("promotePoolSlotToConcrete — reject: not in candidates", () => {
    it("returns success=false with rejectedBecause=not-in-candidates", () => {
        const args: PlacePoolSlotArgs = {
            poolBinding,
        };
        const placeholder = placePoolSlot(args);

        const result = promotePoolSlotToConcrete({
            placeholder,
            chosenCourseId: "CSCI-UA 999",  // NOT in candidates
        });
        expect(result.success).toBe(false);
        expect(result.rejectedBecause).toBe("not-in-candidates");
        expect(result.bound).toBeUndefined();
    });
});

// 4. promotePoolSlotToConcrete rejects when slot already bound
describe("promotePoolSlotToConcrete — reject: already bound", () => {
    it("returns rejectedBecause=already-bound when slot.bindingState is bound", () => {
        // Manually create an already-bound slot
        const args: PlacePoolSlotArgs = {
            poolBinding,
        };
        const placeholder = placePoolSlot(args);
        // Bind it once successfully
        const firstBind = promotePoolSlotToConcrete({
            placeholder,
            chosenCourseId: "CSCI-UA 480",
        });
        expect(firstBind.success).toBe(true);
        const alreadyBound = firstBind.bound!;

        // Try to bind again
        const result = promotePoolSlotToConcrete({
            placeholder: alreadyBound,
            chosenCourseId: "CSCI-UA 490",
        });
        expect(result.success).toBe(false);
        expect(result.rejectedBecause).toBe("already-bound");
    });
});

// 5. Verify bound slot's bindingState is "bound"
describe("promotePoolSlotToConcrete — bound slot state", () => {
    it("produces a slot with bindingState='bound' after successful promotion", () => {
        const args: PlacePoolSlotArgs = {
            poolBinding,
        };
        const placeholder = placePoolSlot(args);
        const result = promotePoolSlotToConcrete({
            placeholder,
            chosenCourseId: "CSCI-UA 476",
        });
        expect(result.success).toBe(true);
        expect(result.bound!.bindingState).toBe("bound");
        // Confirm it is NOT in any intermediate state
        expect(result.bound!.bindingState).not.toBe("candidate-set");
        expect(result.bound!.bindingState).not.toBe("unbound");
    });
});
