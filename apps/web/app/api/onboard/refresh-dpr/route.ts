// ============================================================
// /api/onboard/refresh-dpr — Phase 16 Task B
// ============================================================
// Accepts a fresh DPR PDF from the sidebar's "Update DPR" button.
// Compares the parsed DPR's fingerprint against the stored
// `forward_schedules.dprFingerprint`. On match → no-op. On
// mismatch (or no stored schedule) → wipe the schedule, prune any
// pins on now-completed courses, re-run `plan_forward_degree`
// programmatically, persist the new schedule, return JSON. The
// page consumes the JSON and updates `forwardSchedule` directly
// without a full SSE round-trip.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { extractText } from "unpdf";
import {
    parseDpr,
    computeDprFingerprint,
    loadSchoolConfig,
    pruneCompletedPins,
    planForwardDegreeTool,
    type DegreeProgressReport,
    type ToolSession,
} from "@nyupath/engine";
import { readSessionFromRequest } from "../../../../lib/auth/session";
import { getStores } from "../../../../lib/db/store";
import { consumeRequest } from "../../../../lib/rateLimit";
import { buildStudentProfileFromDpr } from "../../../../lib/buildSession";

export const runtime = "nodejs";

// Match the same per-day cap as /api/onboard so an authenticated
// student can't pummel the parser by spamming Update-DPR.
const REFRESH_DPR_LIMIT_PER_DAY = 10;

/** Audit-log discriminator for the refresh-DPR persist. The audit
 *  table's `field` column is free-form text; `dpr_refresh` is the
 *  conventional value (mirrors the spec's recommendation). */
const REFRESH_DPR_AUDIT_FIELD = "dpr_refresh";

interface RefreshDprResponse {
    changed: boolean;
    schedule?: import("@nyupath/shared").ForwardSchedule;
    state?: string;
    /** The freshly-parsed DPR — echoed on success so the client can
     *  update its `parsedData` state immediately without a page reload.
     *  Shape: `{ kind: "dpr", report: DegreeProgressReport }` —
     *  mirrors the discriminated ParsedTranscript the page uses. */
    dpr?: { kind: "dpr"; report: DegreeProgressReport };
    /** When `changed: false`, the stored schedule (if any) is echoed
     *  back so the UI can re-sync if it drifted from the DB. */
    error?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<RefreshDprResponse | { error: string }>> {
    const auth = await readSessionFromRequest(req);
    if (!auth) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const studentId = auth.sub;

    // Rate-limit BEFORE we touch the multipart body so a flood of 10MB
    // PDFs can't even allocate an ArrayBuffer.
    const rate = consumeRequest(`refresh-dpr:${studentId}`, REFRESH_DPR_LIMIT_PER_DAY);
    if (!rate.ok) {
        return NextResponse.json(
            {
                error:
                    `You've uploaded the maximum number of DPRs today (${rate.limit}). ` +
                    `Try again after ${rate.resetAt}.`,
            },
            {
                status: 429,
                headers: {
                    "Retry-After": String(rate.retryAfterSeconds),
                    "X-RateLimit-Limit": String(rate.limit),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": rate.resetAt,
                },
            },
        );
    }

    let formData: FormData;
    try {
        formData = await req.formData();
    } catch (err) {
        return NextResponse.json(
            { error: `Invalid multipart body: ${err instanceof Error ? err.message : String(err)}` },
            { status: 400 },
        );
    }

    const file = formData.get("dpr") as File | null;
    if (!file) {
        return NextResponse.json({ error: "Missing `dpr` file in multipart body." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
        return NextResponse.json({ error: "DPR file must be a PDF." }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > 10 * 1024 * 1024) {
        return NextResponse.json({ error: "DPR PDF must be under 10 MB." }, { status: 400 });
    }

    // 1. Extract + parse — same deterministic path /api/onboard uses.
    let rawText: string;
    let pageCount = 0;
    try {
        const { text, totalPages } = await extractText(new Uint8Array(bytes), { mergePages: false });
        rawText = Array.isArray(text) ? text.join("\n") : text;
        pageCount = totalPages ?? (Array.isArray(text) ? text.length : 1);
    } catch (err) {
        return NextResponse.json(
            { error: `PDF text extraction failed: ${err instanceof Error ? err.message : String(err)}` },
            { status: 400 },
        );
    }
    const parsed = parseDpr(rawText, { pageCount });
    if (!parsed.ok) {
        return NextResponse.json(
            { error: `DPR parse failed: ${parsed.error}` },
            { status: 400 },
        );
    }
    const newDpr: DegreeProgressReport = parsed.report;

    const stores = getStores(process.env);

    // 2. Fingerprint compare against the stored schedule's fingerprint.
    const newFingerprint = computeDprFingerprint(newDpr);
    let stored: { schedule: import("@nyupath/shared").ForwardSchedule; dprFingerprint: string } | null = null;
    try {
        stored = await stores.scheduleStore.loadLatestSchedule(studentId);
    } catch (err) {
        console.error("[refresh-dpr] loadLatestSchedule failed:", err);
    }
    if (stored && stored.dprFingerprint === newFingerprint) {
        // No meaningful change — short-circuit. Don't even re-persist
        // the parsed DPR (it would be byte-identical anyway).
        return NextResponse.json({ changed: false });
    }

    // 3. Persist the new parsed DPR onto students.parsed_dpr.
    //    persistMutation is the canonical write path; we synthesize an
    //    audit row tagged with field="dpr_refresh" so the trail makes
    //    sense on review. The profile itself is unchanged — re-read the
    //    current one and pass it back in so the upsert is a no-op on
    //    the profile column.
    let currentProfile: import("@nyupath/shared").StudentProfile | null = null;
    try {
        currentProfile = await stores.profileStore.get(studentId);
    } catch (err) {
        console.error("[refresh-dpr] profileStore.get failed:", err);
    }
    // If no profile is persisted yet (rare — the student normally
    // onboards first), synthesize one from the new DPR so the persist
    // call has a target row. The profile will be overwritten on the
    // next confirm_profile_update with whatever the agent decides.
    if (!currentProfile) {
        currentProfile = buildStudentProfileFromDpr(newDpr);
        // Stomp the synthesized id with the canonical auth id so the
        // FK target matches.
        currentProfile.id = studentId;
    } else {
        // Defensive: ensure the persisted profile uses the auth id as
        // its key so the upsert's PK matches the cascade FKs above.
        currentProfile = { ...currentProfile, id: studentId };
    }

    try {
        // The `field` discriminator type is the union of supported
        // StudentProfile fields, but the Postgres `audit_log.field`
        // column is plain text. We tag this audit row with the literal
        // `"dpr_refresh"` so post-mortem reviewers can distinguish a
        // refresh from a real profile mutation. Cast through `unknown`
        // to bridge the type gap — the runtime is happy with any
        // string per the schema.
        await stores.profileStore.persistMutation(
            currentProfile,
            {
                pendingMutationId: `dpr_refresh_${Date.now()}`,
                field: REFRESH_DPR_AUDIT_FIELD as unknown as "homeSchool",
                // before/after carry the fingerprints (not the full DPR)
                // so the audit table doesn't bloat with megabytes of
                // duplicated DPR JSON per refresh.
                before: stored ? { dprFingerprint: stored.dprFingerprint } : null,
                after: { dprFingerprint: newFingerprint },
                confirmedAt: new Date().toISOString(),
            },
            newDpr,
        );
    } catch (err) {
        console.error("[refresh-dpr] persistMutation failed:", err);
        // Persist failure on a refresh is not fatal — the next
        // schedule write still lands and the page can re-fetch on
        // its own — but surface a 500 so the caller knows.
        return NextResponse.json(
            { error: `Failed to persist new DPR: ${err instanceof Error ? err.message : String(err)}` },
            { status: 500 },
        );
    }

    // 4. Drop the stored schedule.
    try {
        await stores.scheduleStore.clearScheduleForStudent(studentId);
    } catch (err) {
        console.error("[refresh-dpr] clearScheduleForStudent failed:", err);
    }

    // 5. Prune pins on now-completed courses; persist the pruned prefs.
    let prefs: import("@nyupath/shared").SchedulePreferences | null = null;
    try {
        prefs = await stores.scheduleStore.loadPreferences(studentId);
    } catch (err) {
        console.error("[refresh-dpr] loadPreferences failed:", err);
    }
    let prunedPrefs = prefs;
    if (prefs) {
        const completedIds = new Set<string>();
        for (const row of newDpr.courseHistory) {
            // "Completed" per Decision #16.1: the row is type=EN OR
            // carries a non-F grade (`grade != null && grade !== "F"`).
            // The conservative read keeps "P" / "TE" in the completed
            // set so a transferred course ALSO drops its pin.
            const isCompleted =
                row.type === "EN"
                || (row.grade !== null && row.grade !== undefined && row.grade !== "F");
            if (!isCompleted) continue;
            const courseId = `${row.subject} ${row.catalogNbr}`.replace(/\s+/g, " ").trim();
            completedIds.add(courseId);
        }
        prunedPrefs = pruneCompletedPins(prefs, completedIds);
        if (prunedPrefs !== prefs) {
            try {
                await stores.scheduleStore.persistPreferences(studentId, prunedPrefs);
            } catch (err) {
                console.error("[refresh-dpr] persistPreferences failed:", err);
            }
        }
    }

    // 6. Re-plan via plan_forward_degree.call(). Construct a minimal
    //    ToolSession that carries everything the tool reads:
    //    - student profile (id + homeSchool + declaredPrograms + flags)
    //    - degreeProgressReport (the new DPR)
    //    - schoolConfig (loaded from the home-school id; controls
    //      maxCreditsPerSemester, f1FullTimeMinCredits, etc.)
    //    - schedulePreferences (the pruned set; may be null)
    //    - scheduleStore (so the tool's existing 16.A persist hook
    //      writes the new schedule directly)
    const schoolConfig = (() => {
        try {
            return loadSchoolConfig(currentProfile.homeSchool);
        } catch {
            return null;
        }
    })();
    const session: ToolSession = {
        student: currentProfile,
        degreeProgressReport: newDpr,
        scheduleStore: stores.scheduleStore,
        ...(schoolConfig ? { schoolConfig } : {}),
        ...(prunedPrefs ? { schedulePreferences: prunedPrefs } : {}),
    };
    const ctx = {
        signal: new AbortController().signal,
        session,
    };

    let planOutput: Awaited<ReturnType<typeof planForwardDegreeTool.call>>;
    try {
        planOutput = await planForwardDegreeTool.call({}, ctx);
    } catch (err) {
        console.error("[refresh-dpr] plan_forward_degree failed:", err);
        return NextResponse.json(
            { error: `Re-plan failed: ${err instanceof Error ? err.message : String(err)}` },
            { status: 500 },
        );
    }

    // The tool already persisted via session.scheduleStore (its
    // existing 16.A wiring), so we just return the schedule.
    // Echo the parsed DPR so the client can update its parsedData
    // without a page reload (FIX 2 — CORE RULE 14 safe: this is the
    // REAL corrected DPR, not a synthetic/what-if DPR).
    return NextResponse.json({
        changed: true,
        schedule: planOutput.schedule,
        state: planOutput.schedule.state,
        dpr: { kind: "dpr" as const, report: newDpr },
    });
}
