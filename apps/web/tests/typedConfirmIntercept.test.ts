// ============================================================
// I3 — typed-confirm intercept helper tests
//
// Covers:
//   1. shouldInterceptAsConfirm: bare confirm phrase + pending proposal → true
//   2. shouldInterceptAsConfirm: bare confirm phrase + NO pending proposal → false
//   3. shouldInterceptAsConfirm: longer message (not a bare phrase) + pending → false
//   4. shouldInterceptAsConfirm: every regex variant fires
//   5. Confirm regex exhaustiveness — spot-check edge cases
//   6. Double-commit guard: typed-confirm after canvas-button-confirm is a
//      no-op at the store level (consume-once guarantee, mirrored from
//      planProposalNoDoubleCommit.test.ts with the TYPED path represented).
// ============================================================

import { describe, it, expect } from "vitest";
import {
    shouldInterceptAsConfirm,
    CONFIRM_PHRASE_RE,
} from "../app/chat/typedConfirmIntercept";

// ---------------------------------------------------------------------------
// 1. Pure-helper unit tests
// ---------------------------------------------------------------------------

describe("shouldInterceptAsConfirm — bare confirm phrase WITH pending proposal", () => {
    const WITH_PENDING = true;

    it.each([
        "confirm",
        "Confirm",
        "CONFIRM",
        "confirm it",
        "Confirm It",
        "yes",
        "Yes",
        "YES",
        "yes please it",
        "yes, please it",
        "yes, please that",
        "yes do it",
        "yes do that",
        "yes, do it",
        "yes, do that",
        "apply",
        "apply it",
        "Apply It",
        "do it",
        "Do It",
    ])("intercepts %s", (phrase) => {
        expect(shouldInterceptAsConfirm(phrase, WITH_PENDING)).toBe(true);
    });
});

describe("shouldInterceptAsConfirm — NO pending proposal (any phrase falls through)", () => {
    const NO_PENDING = false;

    it.each(["confirm", "yes", "apply it", "do it"])(
        "falls through when no pending proposal: %s",
        (phrase) => {
            expect(shouldInterceptAsConfirm(phrase, NO_PENDING)).toBe(false);
        },
    );
});

describe("shouldInterceptAsConfirm — non-bare phrases fall through even WITH pending", () => {
    const WITH_PENDING = true;

    it.each([
        "yes and also change spring",
        "confirm my spring courses",
        "yes please add CSCI-UA 101",
        "can you confirm that for me?",
        "I want to confirm the schedule",
        "do it later",
        "apply the change but check prereqs first",
        "sure",
        "ok",
        "okay",
        "sounds good",
        "",
        "   ",
    ])("falls through for non-bare phrase: %s", (phrase) => {
        // shouldInterceptAsConfirm receives the already-trimmed input
        expect(shouldInterceptAsConfirm(phrase.trim(), WITH_PENDING)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2. CONFIRM_PHRASE_RE exhaustiveness / edge-case checks
// ---------------------------------------------------------------------------

describe("CONFIRM_PHRASE_RE — anchored so substring matches don't fire", () => {
    it("does not match 'yes and also do something'", () => {
        expect(CONFIRM_PHRASE_RE.test("yes and also do something")).toBe(false);
    });

    it("does not match 'please confirm'", () => {
        expect(CONFIRM_PHRASE_RE.test("please confirm")).toBe(false);
    });

    it("does not match 'confirm, but also...'", () => {
        expect(CONFIRM_PHRASE_RE.test("confirm, but also...")).toBe(false);
    });

    it("matches 'yes, please that' (full phrase)", () => {
        expect(CONFIRM_PHRASE_RE.test("yes, please that")).toBe(true);
    });

    it("matches 'confirm it' (with space)", () => {
        expect(CONFIRM_PHRASE_RE.test("confirm it")).toBe(true);
    });

    it("matches 'apply' alone", () => {
        expect(CONFIRM_PHRASE_RE.test("apply")).toBe(true);
    });

    it("does NOT match 'apply and then check conflicts'", () => {
        expect(CONFIRM_PHRASE_RE.test("apply and then check conflicts")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 3. Double-commit scenario: typed confirm after button confirm → once
//
// The store-level idempotency (runConfirmStage no-ops the second call) is
// already locked by planProposalNoDoubleCommit.test.ts.  Here we represent
// the TYPED path by verifying that `shouldInterceptAsConfirm` correctly
// returns `true` for the typed turn, and `false` once the proposal is gone
// (hasPendingProposal = false after the first confirm consumed it).
//
// This mirrors the flow:
//   1. Proposal staged → hasPendingProposal = true
//   2. Canvas Confirm button clicked → proposal consumed (hasPendingProposal = false)
//   3. Student types "confirm" → shouldInterceptAsConfirm(…, false) → false → agent route
//
// The consume-once at the store level ensures even if hasPendingProposal
// somehow stays true (race), runConfirmStage returns unknown_mutation_id.
// ---------------------------------------------------------------------------

describe("I3 double-commit scenario — typed path represented", () => {
    it("step 1: typed 'confirm' with pending proposal → intercept fires", () => {
        expect(shouldInterceptAsConfirm("confirm", true)).toBe(true);
    });

    it("step 2: after proposal is consumed (hasPendingProposal=false), typed 'confirm' falls through to agent", () => {
        // Simulates the state after the canvas Confirm button (or first typed
        // confirm) has consumed the pending mutation — the proposal is gone.
        expect(shouldInterceptAsConfirm("confirm", false)).toBe(false);
    });

    it("step 3: 'yes' behaves identically to 'confirm' across both states", () => {
        expect(shouldInterceptAsConfirm("yes", true)).toBe(true);
        expect(shouldInterceptAsConfirm("yes", false)).toBe(false);
    });
});
