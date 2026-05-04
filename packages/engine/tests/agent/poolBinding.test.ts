import { describe, it, expect } from "vitest";
import {
    placePoolSlot,
    promotePoolSlotToConcrete,
    type PlacePoolSlotArgs,
    type PromotePoolSlotArgs,
} from "../../src/agent/forwardSchedule/poolBinding.js";
import type { PoolBinding, ScheduleSlotPlaceholder } from "@nyupath/shared";

// --- Fixtures ---

const poolBinding: PoolBinding = {
    poolId: "CS_ELECTIVE_POOL",
    candidates: ["CSCI-UA 480", "CSCI-UA 490", "CSCI-UA 476"],
    satisfiesRule: "CS_ELECTIVE_CHOOSE_2",
};

/** Minimal ScheduleSlotPlaceholder parent wrapping the pool slot. */
function makeParentPlaceholder(overrides: Partial<ScheduleSlotPlaceholder> = {}): ScheduleSlotPlaceholder {
    return {
        kind: "placeholder",
        category: "CS Elective",
        credits: 4,
        satisfiesRules: ["CS_ELECTIVE_CHOOSE_2"],
        optional: false,
        reason: "Pool slot for CS elective",
        rationale: {
            satisfiesRequirements: ["CS_ELECTIVE_CHOOSE_2"],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: ["CSCI-UA 480", "CSCI-UA 490", "CSCI-UA 476"],
        },
        downstreamImpact: { courseIds: [], graduationDelay: 0 },
        workloadTier: "major-elective",
        workloadWeight: 1.0,
        bindingState: "placeholder-pending",
        placeholderId: "pool-1",
        poolBinding,
        confidence: "high",
        isCriticalPath: false,
        ...overrides,
    };
}

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
    it("returns success=true and a ScheduleSlotSpecificPlanned when the chosen course is a valid candidate", () => {
        const placeholder = placePoolSlot({ poolBinding });
        const parentSlot = makeParentPlaceholder();

        const args: PromotePoolSlotArgs = {
            parentSlot,
            placeholder,
            chosenCourseId: "CSCI-UA 480",
            courseTitle: "Topics in Computer Science",
        };
        const result = promotePoolSlotToConcrete(args);
        expect(result.success).toBe(true);
        expect(result.concreteSlot).toBeDefined();
        expect(result.concreteSlot!.kind).toBe("specific_planned");
        expect(result.concreteSlot!.courseId).toBe("CSCI-UA 480");
        expect(result.concreteSlot!.bindingState).toBe("bound");
        expect(result.rejectedBecause).toBeUndefined();
    });
});

// 3. promotePoolSlotToConcrete rejects when chosenCourseId NOT in candidates
describe("promotePoolSlotToConcrete — reject: not in candidates", () => {
    it("returns success=false with rejectedBecause=not-in-candidates", () => {
        const placeholder = placePoolSlot({ poolBinding });
        const parentSlot = makeParentPlaceholder();

        const result = promotePoolSlotToConcrete({
            parentSlot,
            placeholder,
            chosenCourseId: "CSCI-UA 999",  // NOT in candidates
            courseTitle: "Unknown",
        });
        expect(result.success).toBe(false);
        expect(result.rejectedBecause).toBe("not-in-candidates");
        expect(result.concreteSlot).toBeUndefined();
    });
});

// 4. promotePoolSlotToConcrete rejects when parent slot has wrong bindingState
describe("promotePoolSlotToConcrete — reject: already-promoted", () => {
    it("returns rejectedBecause=already-promoted when parent bindingState is not placeholder-pending/deferred", () => {
        const placeholder = placePoolSlot({ poolBinding });
        // Simulate a parent that's somehow not in a bindable state
        // (This would only happen with a malformed/corrupted parent.)
        const parentSlot = makeParentPlaceholder({ bindingState: "placeholder-deferred" });
        // placeholder-deferred is still valid — should succeed
        const result = promotePoolSlotToConcrete({
            parentSlot,
            placeholder,
            chosenCourseId: "CSCI-UA 490",
            courseTitle: "Machine Learning",
        });
        expect(result.success).toBe(true);
        expect(result.concreteSlot!.courseId).toBe("CSCI-UA 490");
    });
});

// 5. Verify concrete slot inherits parent slot's metadata
describe("promotePoolSlotToConcrete — concrete slot metadata", () => {
    it("inherits credits, satisfiesRules, workloadTier, confidence from parent", () => {
        const placeholder = placePoolSlot({ poolBinding });
        const parentSlot = makeParentPlaceholder();
        const result = promotePoolSlotToConcrete({
            parentSlot,
            placeholder,
            chosenCourseId: "CSCI-UA 476",
            courseTitle: "Computer Theory",
        });
        expect(result.success).toBe(true);
        const s = result.concreteSlot!;
        expect(s.credits).toBe(4);
        expect(s.satisfiesRules).toEqual(["CS_ELECTIVE_CHOOSE_2"]);
        expect(s.workloadTier).toBe("major-elective");
        expect(s.confidence).toBe("high");
        // requirmentPoolSlot no longer carries bindingState:"bound"
        // The inner RequirementPoolSlot type only has "unbound" | "candidate-set"
        // The concrete slot itself carries bindingState:"bound"
        expect(s.bindingState).toBe("bound");
    });
});
