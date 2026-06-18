// ============================================================
// /api/whatif-audit — Plan 35 Branch A (G4.1)
// ============================================================
// Accepts an Albert "What-If" / "Career Simulation" report PDF that a
// student exports when EXPLORING a PROGRAM change (declare/switch a
// major, add a minor, change school). It parses deterministically as a
// DPR (the parser sets `reportKind: "what_if"` for these reports) and
// plans against the HYPOTHETICAL program as a labeled, read-only
// EXPLORATION.
//
// Branch A invariants (plan §3 + §3.1):
//   - The result renders as "What-if: hypothetical <program> — not your
//     committed plan". It is NOT confirmable as the committed plan: no
//     real DPR backs the change.
//   - The authoritative `students.parsed_dpr` is NEVER overwritten, and
//     NO committed `forward_schedule` is persisted from this route. The
//     ToolSession we hand the planner carries NO `scheduleStore`, so the
//     plan tool's persistence hook (gated on `session.scheduleStore`) is
//     a no-op, and we never touch `profileStore`. The G0.2
//     `assertAuthoritativeDpr` guard is a second line of defense — it
//     throws on any what_if write — but this route never even attempts a
//     profile/DPR write.
//   - A NORMAL DPR uploaded here is rejected with a redirect message to
//     /api/onboard; we never plan a real DPR as an exploration.
//   - The CTA is: declare it in Albert, then upload your new (real) DPR
//     via the normal onboarding/refresh flow to make it the committed
//     plan.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { extractText } from "unpdf";
import {
    parseDpr,
    loadSchoolConfig,
    planForwardDegreeTool,
    type DegreeProgressReport,
    type ToolSession,
} from "@nyupath/engine";
import type { ForwardSchedule } from "@nyupath/shared";
import { consumeRequest } from "../../../lib/rateLimit";
import { buildStudentProfileFromDpr } from "../../../lib/buildSession";

export const runtime = "nodejs";

// Mirror the same per-day cap as /api/onboard so the parser CPU can't be
// pummelled by a flood of 10 MB uploads. Bucketed by source IP — like
// onboarding, an exploration upload precedes (or is independent of) any
// authenticated chat client id.
const WHATIF_AUDIT_LIMIT_PER_DAY = 10;

function ipFromRequest(req: NextRequest): string {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return `whatif-audit-ip:${fwd.split(",")[0]!.trim()}`;
    const real = req.headers.get("x-real-ip");
    if (real) return `whatif-audit-ip:${real.trim()}`;
    return "whatif-audit-ip:anonymous";
}

/** Branch-A exploration payload returned to the caller (chat/agent
 *  surfaces the label + CTA; the canvas may render the schedule behind a
 *  non-confirmable "hypothetical" badge). */
export interface WhatIfAuditExploration {
    /** The hypothetical forward plan computed against the what-if DPR.
     *  Read-only — NOT persisted, NOT confirmable as the committed plan. */
    schedule: ForwardSchedule;
    /** Human-readable solver summary (same one plan_forward_degree emits). */
    summary: string;
    /** The hypothetical program name(s) derived from the what-if report. */
    hypotheticalProgram: string;
}

export interface WhatIfAuditResponse {
    exploration: WhatIfAuditExploration;
    /** Canvas/chat banner. Always flags this as hypothetical, never committed. */
    label: string;
    /** The single next step to make this real. */
    cta: string;
}

// ============================================================
// Core handler — exported for direct (no-multipart) testing
// ============================================================

/**
 * Derive a human-readable hypothetical-program label from the parsed
 * what-if report's Programs table. Prefers the academic program rows
 * (Major / Minor / Concentration / Specialization), since the
 * "Undergraduate Career" + "Program" rows are administrative. Falls back
 * to whatever labels are present, then to a generic phrase.
 */
export function deriveHypotheticalProgram(report: DegreeProgressReport): string {
    const ACADEMIC = /major|minor|concentration|specialization/i;
    const academic = report.programs.filter((p) => ACADEMIC.test(p.programType));
    const pick = academic.length > 0 ? academic : report.programs;
    const labels = pick
        .map((p) => p.label.trim())
        .filter((l) => l.length > 0 && !/^UA-|career$/i.test(l));
    if (labels.length === 0) return "this program";
    // De-dupe while preserving order.
    const seen = new Set<string>();
    const uniq = labels.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
    return uniq.join(" + ");
}

/**
 * Plan a parsed `what_if` report as a read-only exploration. Builds a
 * profile from the report, loads the (best-effort) school config, and
 * runs the SAME plan machinery onboarding uses — but with NO
 * `scheduleStore` on the session, so the plan tool's persistence hook is
 * skipped. This function performs NO profile/DPR/schedule writes.
 *
 * @throws if `report.reportKind !== "what_if"` — callers must route a
 *         normal DPR to /api/onboard, never plan it here.
 */
export async function planWhatIfExploration(
    report: DegreeProgressReport,
): Promise<WhatIfAuditResponse> {
    if (report.reportKind !== "what_if") {
        throw new Error(
            "planWhatIfExploration requires a what_if report; got reportKind=" + report.reportKind,
        );
    }

    // Build a synthetic, in-memory profile from the hypothetical DPR.
    // This is never persisted — it exists only to feed the planner.
    const profile = buildStudentProfileFromDpr(report);

    const schoolConfig = (() => {
        try {
            return loadSchoolConfig(profile.homeSchool);
        } catch {
            return null;
        }
    })();

    // CRITICAL: no `scheduleStore` on the session → the plan tool's
    // Phase-16 persistSchedule hook (gated on session.scheduleStore) is a
    // no-op. We also never construct/touch a profileStore here.
    const session: ToolSession = {
        student: profile,
        degreeProgressReport: report,
        ...(schoolConfig ? { schoolConfig } : {}),
    };
    const ctx = { signal: new AbortController().signal, session };

    const planOutput = await planForwardDegreeTool.call({}, ctx);

    const hypotheticalProgram = deriveHypotheticalProgram(report);
    return {
        exploration: {
            schedule: planOutput.schedule,
            summary: planOutput.summary,
            hypotheticalProgram,
        },
        label: `What-if: hypothetical ${hypotheticalProgram} — not your committed plan.`,
        cta: "To make this real, declare it in Albert and upload your new (real) DPR.",
    };
}

// ============================================================
// Route
// ============================================================

export async function POST(req: NextRequest): Promise<NextResponse> {
    // Gate BEFORE touching the multipart body.
    const rate = consumeRequest(ipFromRequest(req), WHATIF_AUDIT_LIMIT_PER_DAY);
    if (!rate.ok) {
        return NextResponse.json(
            {
                message:
                    `You've uploaded the maximum number of what-if reports from this IP today (${rate.limit}). ` +
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
            { message: `Invalid multipart body: ${err instanceof Error ? err.message : String(err)}` },
            { status: 400 },
        );
    }

    const file = formData.get("dpr") as File | null;
    if (!file) {
        return NextResponse.json(
            { message: "Please upload your Albert What-If report as a PDF (multipart field `dpr`)." },
            { status: 400 },
        );
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
        return NextResponse.json(
            { message: "The What-If file must be a PDF. Re-export it from Albert via Print → Save as PDF." },
            { status: 400 },
        );
    }

    const bytes = await file.arrayBuffer();
    const sizeMB = (bytes.byteLength / 1024 / 1024).toFixed(1);
    if (bytes.byteLength > 10 * 1024 * 1024) {
        return NextResponse.json(
            { message: `That PDF is ${sizeMB} MB — please upload a file under 10 MB.` },
            { status: 400 },
        );
    }

    // 1. Extract text — same deterministic path onboarding uses.
    let rawText: string;
    let pageCount = 0;
    try {
        const { text, totalPages } = await extractText(new Uint8Array(bytes), { mergePages: false });
        rawText = Array.isArray(text) ? text.join("\n") : text;
        pageCount = totalPages ?? (Array.isArray(text) ? text.length : 1);
    } catch (err) {
        console.error("[whatif-audit] PDF extract error:", err);
        return NextResponse.json(
            {
                message:
                    "I couldn't read text out of that PDF. Make sure it's a real PDF (not a screenshot), " +
                    "re-export from Albert via Print → Save as PDF, then try again.",
            },
            { status: 400 },
        );
    }

    // 2. Parse deterministically.
    const parsed = parseDpr(rawText, { pageCount });
    if (!parsed.ok) {
        return NextResponse.json(
            {
                message:
                    "I extracted the text but couldn't recognize the report layout. " +
                    "Double-check that you uploaded an Albert What-If report, then try again.",
                error: parsed.error,
            },
            { status: 400 },
        );
    }
    const report = parsed.report;

    // 3. Wrong-kind guard: a NORMAL DPR uploaded here is NOT planned as an
    //    exploration. Redirect the student to the real onboarding flow.
    if (report.reportKind !== "what_if") {
        return NextResponse.json(
            {
                message:
                    "This looks like your real Degree Progress Report — upload it at /api/onboard to set your " +
                    "committed plan. The what-if-audit endpoint is for Albert What-If reports only.",
                redirect: "/api/onboard",
            },
            { status: 400 },
        );
    }

    // 4. Plan the what-if report as a read-only EXPLORATION. No writes.
    try {
        const result = await planWhatIfExploration(report);
        return NextResponse.json(result);
    } catch (err) {
        console.error("[whatif-audit] exploration plan failed:", err);
        return NextResponse.json(
            { message: `Couldn't build the what-if exploration: ${err instanceof Error ? err.message : String(err)}` },
            { status: 500 },
        );
    }
}
