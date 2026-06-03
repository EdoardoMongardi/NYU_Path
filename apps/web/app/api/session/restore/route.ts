// ============================================================
// /api/session/restore — Phase 16 Task B
// ============================================================
// Returns everything needed to land a returning student back in
// their last conversation:
//   - profile (StudentProfile | null)
//   - dpr (DegreeProgressReport | null)
//   - forwardSchedule | studentDraftPlan (ForwardSchedule | null —
//     the latest non-superseded row, routed to the correct slot per
//     Decision #32 state)
//   - schedulePreferences (SchedulePreferences | null)
//   - chatMessages (ChatMessageRecord[] in chronological order,
//     default last 50, configurable via NYUPATH_CHAT_HISTORY_RESTORE_LIMIT)
//
// When `profile === null` the page falls through to the existing
// onboarding flow. When `dpr === null` but `profile` is present we
// also treat as re-onboard (pre-Phase-16 data).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { readSessionFromRequest } from "../../../../lib/auth/session";
import { getStores } from "../../../../lib/db/store";

export const runtime = "nodejs";

const DEFAULT_RESTORE_LIMIT = 50;

function resolveRestoreLimit(env: Record<string, string | undefined> = process.env): number {
    const raw = env.NYUPATH_CHAT_HISTORY_RESTORE_LIMIT;
    if (!raw) return DEFAULT_RESTORE_LIMIT;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESTORE_LIMIT;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
    const auth = await readSessionFromRequest(req);
    if (!auth) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const studentId = auth.sub;

    const stores = getStores(process.env);

    // Mirror the v2-route bootstrap order: profile + parsed DPR first,
    // then schedule, preferences, chat messages. All reads are best-
    // effort: a single store failure must not blank the whole restore
    // (the page still renders something usable when one slice is gone).
    let profile = null;
    try {
        profile = await stores.profileStore.get(studentId);
    } catch (err) {
        console.error("[session/restore] profileStore.get failed:", err);
    }

    let dpr = null;
    try {
        dpr = (await stores.profileStore.getParsedDpr?.(studentId)) ?? null;
    } catch (err) {
        console.error("[session/restore] profileStore.getParsedDpr failed:", err);
    }

    let forwardSchedule = null;
    let studentDraftPlan = null;
    try {
        const loaded = await stores.scheduleStore.loadLatestSchedule(studentId);
        if (loaded) {
            // Decision #32 state-routing — infeasible-draft and
            // student-preferred-invalid-draft live in the draft slot so
            // the agent never endorses an illegal plan as official.
            const isDraft =
                loaded.schedule.state === "infeasible-draft" ||
                loaded.schedule.state === "student-preferred-invalid-draft";
            if (isDraft) {
                studentDraftPlan = loaded.schedule;
            } else {
                forwardSchedule = loaded.schedule;
            }
        }
    } catch (err) {
        console.error("[session/restore] scheduleStore.loadLatestSchedule failed:", err);
    }

    let schedulePreferences = null;
    try {
        schedulePreferences = await stores.scheduleStore.loadPreferences(studentId);
    } catch (err) {
        console.error("[session/restore] scheduleStore.loadPreferences failed:", err);
    }

    let chatMessages: import("@nyupath/engine").ChatMessageRecord[] = [];
    try {
        chatMessages = await stores.chatHistoryStore.loadRecentMessages(
            studentId,
            resolveRestoreLimit(),
        );
    } catch (err) {
        console.error("[session/restore] chatHistoryStore.loadRecentMessages failed:", err);
    }

    return NextResponse.json({
        profile,
        dpr,
        forwardSchedule,
        studentDraftPlan,
        schedulePreferences,
        chatMessages,
    });
}
