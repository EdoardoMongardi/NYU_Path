// ============================================================
// Plan 36 H4.2b-2 — v2 route `whatif_audit_request` SSE emit
// ============================================================
// End-to-end route proof that, when the agent calls the
// `what_if_audit` tool (whose result summary carries an
// `AUDIT_UPLOAD_OFFER: <label>` marker line), the route emits exactly
// one `whatif_audit_request` SSE event carrying the trimmed label as
// `hypotheticalProgram`, and that the event lands BEFORE the terminal
// `done` event. We mock ONLY the streaming agent loop (no real LLM
// call); the REAL `extractAuditUploadOffer` + `validateResponse` run.
//
// The pure-function tests for `extractAuditUploadOffer` live in
// tests/chatV2Client.test.ts; this file pins the route WIRING.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../app/api/chat/v2/route";
import { parseDpr, type ChatTurnResult, type ToolInvocation } from "@nyupath/engine";
import { resetStoresForTests } from "../lib/db/store";

const AGENT_ANSWER = "Switching to Economics is a hypothetical program change. This is an estimate.";
const AUDIT_LABEL = "Economics (BA)";

// The `what_if_audit` invocation the mocked loop returns. Its summary
// carries the machine-extractable marker line the route regexes.
const AUDIT_INVOCATION: ToolInvocation = {
    toolName: "what_if_audit",
    args: { hypotheticalPrograms: ["econ-ba"] },
    summary: [
        "WHAT-IF (estimate — there is no DPR for a hypothetical program)",
        "  Requested program(s): econ-ba",
        "  Guidance: explore via the Albert What-If audit",
        "  REQUIRED DISCLAIMER (must appear verbatim in your reply): This is an estimate.",
        `AUDIT_UPLOAD_OFFER: ${AUDIT_LABEL}`,
    ].join("\n"),
} as ToolInvocation;

// Mock ONLY the streaming agent loop + force the ambiguity gate to
// report not-ambiguous so the route skips the clarifier's LLM call and
// goes straight to the (mocked) agent loop. importOriginal keeps
// `extractAuditUploadOffer`, `validateResponse`, etc. all REAL. Without
// the `detectAmbiguity` stub the "What if…?" message trips the
// clarifier, which attempts a real LLM call (fails with a fake key,
// then falls through) — deterministic-but-slow, which flakes under
// full-suite load. Stubbing it keeps the test pinning the route WIRING
// only.
vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        detectAmbiguity: () => ({ ambiguous: false, signals: [], contentTokens: [] }),
        runAgentTurnStreaming: async function* () {
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: AGENT_ANSWER,
                invocations: [AUDIT_INVOCATION],
                turnMessages: [],
                usage: { promptTokens: 0, completionTokens: 0 },
                modelUsedId: "test-model",
                transitions: [],
            };
            yield { type: "tool_invocation_done" as const, invocation: AUDIT_INVOCATION };
            yield { type: "done" as const, result };
        },
    };
});

const DPR_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);
function validDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return { kind: "dpr", report: r.report };
}

function fakeRequest(body: unknown): { json: () => Promise<unknown> } {
    return { json: async () => body };
}

async function drainSse(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
    }
    return body;
}

/** Parse the drained SSE text into ordered { kind, data } entries. */
function parseEvents(sse: string): Array<{ kind: string; data: Record<string, unknown> }> {
    const out: Array<{ kind: string; data: Record<string, unknown> }> = [];
    for (const block of sse.split("\n\n")) {
        let kind: string | null = null;
        let dataLine: string | null = null;
        for (const raw of block.split("\n")) {
            const line = raw.replace(/\r$/, "");
            if (line.startsWith("event: ")) kind = line.slice("event: ".length);
            else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
        }
        if (kind && dataLine) {
            try {
                out.push({ kind, data: JSON.parse(dataLine) as Record<string, unknown> });
            } catch { /* ignore unparsable block */ }
        }
    }
    return out;
}

describe("v2 route whatif_audit_request SSE emit (Plan 36 H4.2b)", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-whatif-audit-test";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-whatif-audit-test";
        resetStoresForTests();
    });

    afterEach(() => {
        if (ORIGINAL.openai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = ORIGINAL.openai;
        if (ORIGINAL.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = ORIGINAL.anthropic;
        if (ORIGINAL.dbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL.dbUrl;
        if (ORIGINAL.sessionPath === undefined) delete process.env.NYUPATH_SESSION_STORE_PATH;
        else process.env.NYUPATH_SESSION_STORE_PATH = ORIGINAL.sessionPath;
        resetStoresForTests();
        vi.restoreAllMocks();
    });

    it("emits exactly one whatif_audit_request carrying the trimmed label, before done", async () => {
        const res = await POST(fakeRequest({
            message: "What if I switched to Economics?",
            parsedData: validDprPayload(),
            history: [],
        }) as never);
        expect(res.status).toBe(200);

        const events = parseEvents(await drainSse(res));
        const auditEvents = events.filter((e) => e.kind === "whatif_audit_request");
        expect(auditEvents).toHaveLength(1);
        expect(auditEvents[0]!.data).toMatchObject({
            kind: "whatif_audit_request",
            hypotheticalProgram: AUDIT_LABEL,
        });

        // The event must land BEFORE the terminal `done` event.
        const kinds = events.map((e) => e.kind);
        expect(kinds.indexOf("whatif_audit_request")).toBeLessThan(kinds.indexOf("done"));
    });
});
