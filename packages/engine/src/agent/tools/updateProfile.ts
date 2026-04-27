// ============================================================
// update_profile + confirm_profile_update (Phase 5 §7.2 two-step)
// ============================================================
// Architecture §7.2 specifies a two-step write contract:
//
//   1. `update_profile.call()` — STAGES a preview in
//      `session.pendingMutations` and returns the preview. Does NOT
//      mutate the profile. Status is `pending_confirmation`.
//   2. `confirm_profile_update.call({ pendingMutationId })` — applies
//      the staged preview to `session.student`. Idempotent on a
//      consumed id.
//
// The earlier Phase-5-author implementation collapsed this to an
// immediate mutation in `update_profile.call()`. The reviewer correctly
// flagged that as a P0 architectural deviation. This file restores the
// two-step contract.
// ============================================================

import { z } from "zod";
import { buildTool, type PendingProfileMutation } from "../tool.js";
import type { ProgramDeclaration, StudentProfile } from "@nyupath/shared";

const updateFieldSchema = z.discriminatedUnion("field", [
    z.object({
        field: z.literal("homeSchool"),
        value: z.string().min(1),
    }),
    z.object({
        field: z.literal("catalogYear"),
        value: z.string().regex(/^\d{4}(-\d{4})?$/),
    }),
    z.object({
        field: z.literal("declaredPrograms"),
        value: z.array(z.object({
            programId: z.string().min(1),
            programType: z.enum(["major", "minor", "concentration"]),
            declaredAt: z.string().optional(),
            declaredUnderCatalogYear: z.string().optional(),
        })),
    }),
    z.object({
        field: z.literal("visaStatus"),
        value: z.enum(["f1", "domestic", "other"]),
    }),
]);

let pendingIdCounter = 0;
function nextPendingId(): string {
    pendingIdCounter += 1;
    return `pm_${Date.now()}_${pendingIdCounter}`;
}

function describeImpacts(
    field: PendingProfileMutation["field"],
    before: unknown,
    after: unknown,
): string[] {
    const impacts: string[] = [];
    switch (field) {
        case "homeSchool":
            impacts.push(
                `Audit + planner will switch to the ${after} SchoolConfig (residency, P/F, credit caps).`,
                `Internal-transfer eligibility checks become unsupported until the new home-school's data is loaded.`,
            );
            break;
        case "catalogYear":
            impacts.push(
                `Program rules will be loaded from the ${after} snapshot (per-§11.0.3 catalog-year pinning).`,
                `Already-completed courses are unaffected; only future audits use the new year.`,
            );
            break;
        case "declaredPrograms":
            impacts.push(
                `Audits will run against the new program list. Existing courses will be re-counted.`,
                `Cross-program double-counting limits re-evaluate immediately.`,
            );
            break;
        case "visaStatus":
            impacts.push(
                `Enrollment checks will ${after === "f1" ? "REQUIRE F-1 full-time minimums" : "no longer apply F-1 minimums"}.`,
                `Plan suggestions will be re-filtered for visa-specific rules.`,
            );
            break;
    }
    impacts.push(`Previous value: ${JSON.stringify(before)}.`);
    return impacts;
}

export const updateProfileTool = buildTool({
    name: "update_profile",
    description:
        "Stages a preview of a single profile-field change (homeSchool / " +
        "catalogYear / declaredPrograms / visaStatus). DOES NOT apply the " +
        "change — returns a preview the agent must surface to the user " +
        "verbatim. The user must confirm explicitly; on confirmation, the " +
        "agent calls `confirm_profile_update` with the returned " +
        "pendingMutationId. Two-step write per §7.2.",
    inputSchema: updateFieldSchema,
    isReadOnly: true, // staging-only; no profile mutation here
    maxResultChars: 2000,
    async validateInput(_input, { session }) {
        if (!session.student) return { ok: false, userMessage: "No student profile loaded." };
        return { ok: true };
    },
    prompt: () =>
        `Stage a profile-update PREVIEW. The user MUST confirm before the ` +
        `change is applied. To apply, call confirm_profile_update with the ` +
        `pendingMutationId returned here.`,
    async call(input, { session }) {
        const student = session.student!;
        const before: Partial<StudentProfile> = {};
        const after: Partial<StudentProfile> = {};
        switch (input.field) {
            case "homeSchool":
                before.homeSchool = student.homeSchool;
                after.homeSchool = input.value;
                break;
            case "catalogYear":
                before.catalogYear = student.catalogYear;
                after.catalogYear = input.value;
                break;
            case "declaredPrograms":
                before.declaredPrograms = student.declaredPrograms;
                after.declaredPrograms = input.value as ProgramDeclaration[];
                break;
            case "visaStatus":
                before.visaStatus = student.visaStatus;
                after.visaStatus = input.value;
                break;
        }
        const id = nextPendingId();
        const mutation: PendingProfileMutation = {
            id,
            field: input.field,
            before: (before as Record<string, unknown>)[input.field],
            after: (after as Record<string, unknown>)[input.field],
            impacts: describeImpacts(
                input.field,
                (before as Record<string, unknown>)[input.field],
                (after as Record<string, unknown>)[input.field],
            ),
        };
        if (!session.pendingMutations) session.pendingMutations = new Map();
        session.pendingMutations.set(id, mutation);
        return {
            status: "pending_confirmation" as const,
            pendingMutationId: id,
            mutation,
        };
    },
    summarizeResult(out) {
        return [
            `STATUS: pending_confirmation`,
            `pendingMutationId: ${out.pendingMutationId}`,
            `field: ${out.mutation.field}`,
            `before: ${JSON.stringify(out.mutation.before)}`,
            `after: ${JSON.stringify(out.mutation.after)}`,
            `impacts:`,
            ...out.mutation.impacts.map((i) => `  - ${i}`),
            ``,
            `To apply this change, call confirm_profile_update with pendingMutationId="${out.pendingMutationId}".`,
        ].join("\n");
    },
});

// ============================================================
// confirm_profile_update — applies a staged preview
// ============================================================

export const confirmProfileUpdateTool = buildTool({
    name: "confirm_profile_update",
    description:
        "Applies a previously-staged profile mutation by id. ONLY call after " +
        "the user has explicitly confirmed the preview returned by " +
        "update_profile. Idempotent on a consumed id.",
    inputSchema: z.object({
        pendingMutationId: z.string().min(1),
    }),
    isReadOnly: false,
    maxResultChars: 1000,
    async validateInput(input, { session }) {
        if (!session.student) return { ok: false, userMessage: "No student profile loaded." };
        const pending = session.pendingMutations?.get(input.pendingMutationId);
        if (!pending) {
            return {
                ok: false,
                userMessage:
                    `No pending mutation with id "${input.pendingMutationId}". ` +
                    `Either it was already consumed or update_profile was not called first.`,
            };
        }
        return { ok: true };
    },
    prompt: () =>
        `Apply a previously-staged profile mutation. Required input: ` +
        `pendingMutationId from a prior update_profile preview. Mutates ` +
        `the in-memory profile.`,
    async call(input, { session }) {
        const student = session.student!;
        const mutation = session.pendingMutations!.get(input.pendingMutationId)!;
        switch (mutation.field) {
            case "homeSchool":
                student.homeSchool = mutation.after as string;
                break;
            case "catalogYear":
                student.catalogYear = mutation.after as string;
                break;
            case "declaredPrograms":
                student.declaredPrograms = mutation.after as ProgramDeclaration[];
                break;
            case "visaStatus":
                student.visaStatus = mutation.after as "f1" | "domestic" | "other";
                break;
        }
        // Consume so a second confirm of the same id returns the
        // "already_consumed" path (validateInput surfaces "no pending"
        // because the entry has been removed). This prevents accidental
        // double-application within one turn.
        session.pendingMutations!.delete(input.pendingMutationId);

        // Phase 7-B Step 10: persist the post-mutation profile + an
        // immutable audit row when a ProfileStore is wired into the
        // session. Persistence failures must NOT throw — the in-memory
        // mutation already landed and the live turn is the source of
        // truth.
        if (session.profileStore) {
            try {
                await session.profileStore.persistMutation(student, {
                    pendingMutationId: input.pendingMutationId,
                    field: mutation.field,
                    before: mutation.before,
                    after: mutation.after,
                    confirmedAt: new Date().toISOString(),
                });
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[confirm_profile_update] persistMutation failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        return {
            status: "applied" as const,
            mutation,
        };
    },
    summarizeResult(out) {
        return `APPLIED ${out.mutation.field}: ${JSON.stringify(out.mutation.before)} → ${JSON.stringify(out.mutation.after)}`;
    },
});
