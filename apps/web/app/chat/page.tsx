"use client";

import { useState, useRef, useCallback } from "react";
import styles from "./chat.module.css";
import { streamChatV2, extractPendingMutationId, type ChatV2Event } from "../../lib/chatV2Client";
import { getActiveVerb, getPastVerb, IDLE_VERB } from "../../lib/agentStatusVerbs";
import { formatDuration } from "../../lib/formatDuration";

// Phase 7-E W10 reviewer P1-2 — stable per-browser UUID so each
// student gets their own rate-limit bucket (instead of every
// cohort-A user sharing a single "anonymous" bucket). Stored in
// localStorage; a fresh browser/incognito-session gets a new id.
// Replaced by real auth-derived ids in W12.
const USER_ID_LS_KEY = "nyupath:client-id";
function getOrCreateClientId(): string {
    if (typeof window === "undefined") return "anonymous";
    try {
        const cached = window.localStorage.getItem(USER_ID_LS_KEY);
        if (cached) return cached;
        const next = window.crypto?.randomUUID
            ? window.crypto.randomUUID()
            : `cohortA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        window.localStorage.setItem(USER_ID_LS_KEY, next);
        return next;
    } catch {
        return "anonymous";
    }
}

interface ToolStatus {
    toolName: string;
    state: "running" | "done" | "error";
    summary?: string;
    error?: string;
}

interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
    /** Per-message tool-invocation log (rendered inline above the bubble) */
    toolStatuses?: ToolStatus[];
    /** Per-message validator violations (rendered as a warning chip below the bubble) */
    validatorViolations?: Array<{ kind: string; detail: string; caveatId?: string }>;
    /** Phase 5 §7.2 two-step profile-update affordance — present when
     *  this message reports a `pendingMutationId` from `update_profile`. */
    pendingMutationId?: string;
    /** Agent-status UX: epoch ms when the v2 stream was opened. Set
     *  on assistant messages only; absent on welcome / v1 / user. */
    startedAt?: number;
    /** Agent-status UX: epoch ms when the `done` SSE event arrived. */
    completedAt?: number;
    /** Agent-status UX: epoch ms when an `error` event arrived. Used
     *  to render "Failed after Xs" instead of "Thought for Xs". */
    failedAt?: number;
    /** Agent-status UX: whether the user has expanded the trace. */
    traceExpanded?: boolean;
}

type OnboardingStep = "awaiting_dpr" | "awaiting_transcript" | "confirming_data" | "correcting_data" | "asking_visa" | "asking_graduation" | "complete" | "unsupported_major";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ParsedTranscript = Record<string, any>;

const WELCOME_MESSAGE: Message = {
    id: "welcome",
    role: "assistant",
    content: `Welcome to **NYU Path** 🎓\n\nI'll help you plan your courses and track your degree progress.\n\nTo get started, please upload your **Degree Progress Report (DPR)** as a PDF.\n\nIn Albert: **Academics tab → Planning Tools → Degree Progress Report**. When the report opens in a new window, save it as PDF (browser print → "Save as PDF") and drop it below.\n\n📎 Drag & drop or click to upload!`,
    timestamp: new Date(),
};

function currentVerbFor(toolStatuses: ToolStatus[] | undefined): string {
    if (!toolStatuses || toolStatuses.length === 0) return IDLE_VERB;
    // Latest tool wins. If nothing is currently running (between
    // tool calls), the most-recent done tool's *active* form is a
    // worse fit than IDLE_VERB, so we fall back to "Thinking".
    const lastRunning = [...toolStatuses].reverse().find(t => t.state === "running");
    if (lastRunning) return getActiveVerb(lastRunning.toolName);
    return IDLE_VERB;
}

export default function ChatPage() {
    const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>("awaiting_dpr");
    const [isDragOver, setIsDragOver] = useState(false);
    const [parsedData, setParsedData] = useState<ParsedTranscript | null>(null);
    const [visaStatus, setVisaStatus] = useState<string | null>(null);
    const [graduationTarget, setGraduationTarget] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const addMessage = (role: "user" | "assistant", content: string): Message => {
        const msg: Message = {
            id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
            role,
            content,
            timestamp: new Date(),
        };
        setMessages(prev => [...prev, msg]);
        setTimeout(scrollToBottom, 100);
        return msg;
    };

    const updateMessage = (id: string, patch: Partial<Message>) => {
        setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
    };

    /**
     * Phase 6.5 P-1 cutover: post-onboarding messages flow through the
     * SSE v2 endpoint (`/api/chat/v2`). Tool invocations and validator
     * blocks are surfaced inline. Onboarding turns continue to use the
     * legacy `/api/chat` JSON route per Option B (the agent loop
     * doesn't replicate the onboarding state machine).
     */
    const handleSendV2 = async (userText: string) => {
        const recentHistory = messages
            .filter(m => m.id !== "welcome")
            .slice(-10)
            .map(m => ({ role: m.role, content: m.content }));

        // Pre-create the assistant bubble so tokens stream INTO it.
        const assistant = addMessage("assistant", "");
        updateMessage(assistant.id, { startedAt: Date.now() });
        const toolStatuses: ToolStatus[] = [];

        for await (const ev of streamChatV2({
            message: userText,
            parsedData,
            visaStatus,
            graduationTarget,
            history: recentHistory,
            userId: getOrCreateClientId(),
        })) {
            applyEvent(ev, assistant.id, toolStatuses);
        }
    };

    const applyEvent = (ev: ChatV2Event, assistantId: string, toolStatuses: ToolStatus[]) => {
        switch (ev.kind) {
            case "template_match":
                updateMessage(assistantId, {
                    content: ev.body,
                    // Surface the source so the user can verify the citation.
                    toolStatuses: [...toolStatuses, { toolName: `template:${ev.templateId}`, state: "done", summary: ev.source }],
                });
                break;
            case "tool_invocation_start":
                toolStatuses.push({ toolName: ev.toolName, state: "running" });
                updateMessage(assistantId, { toolStatuses: [...toolStatuses] });
                break;
            case "tool_invocation_done": {
                const idx = toolStatuses.findIndex(t => t.toolName === ev.toolName && t.state === "running");
                if (idx >= 0) {
                    toolStatuses[idx] = {
                        toolName: ev.toolName,
                        state: ev.error ? "error" : "done",
                        summary: ev.summary,
                        error: ev.error,
                    };
                }
                const pendingId = ev.toolName === "update_profile" ? extractPendingMutationId(ev.summary) : null;
                updateMessage(assistantId, {
                    toolStatuses: [...toolStatuses],
                    ...(pendingId ? { pendingMutationId: pendingId } : {}),
                });
                break;
            }
            case "token":
                // Block-streaming v2 emits the full text as a single
                // token event. The handler still APPENDS rather than
                // overwriting so a future intra-token streaming
                // upgrade is drop-in compatible.
                setMessages(prev => prev.map(m => m.id === assistantId
                    ? { ...m, content: (m.content || "") + ev.text }
                    : m));
                setTimeout(scrollToBottom, 50);
                break;
            case "validator_block":
                updateMessage(assistantId, {
                    validatorViolations: ev.violations.map(v => ({
                        kind: v.kind,
                        detail: v.detail,
                        ...(v.caveatId ? { caveatId: v.caveatId } : {}),
                    })),
                });
                break;
            case "done":
                // Final reconciliation — the server's `finalText` is
                // authoritative. For block-streaming this matches the
                // accumulated tokens; for future intra-token streaming
                // this guards against partial-chunk artifacts.
                updateMessage(assistantId, { content: ev.finalText, completedAt: Date.now() });
                break;
            case "error": {
                // Don't leak raw exception text (file paths, internal
                // identifiers, etc.) to the student. Log the detail so
                // the operator can correlate via /admin/observability;
                // show a generic but useful copy in-chat.
                console.error("[chat v2 error]", ev.message);
                const friendly =
                    `Something went wrong on our side handling that turn. ` +
                    `Try resending — if it keeps happening, email the operator at edoardo.mongardi18@gmail.com.`;
                const existing = assistantId ? messages.find(m => m.id === assistantId)?.content : "";
                updateMessage(assistantId, {
                    content: existing && existing.length > 0 ? existing : friendly,
                    failedAt: Date.now(),
                });
                break;
            }
        }
    };

    /** Legacy v1 path — kept for onboarding turns. */
    const handleSendV1 = async (userText: string) => {
        const recentHistory = messages
            .filter(m => m.id !== "welcome")
            .slice(-10)
            .map(m => ({ role: m.role, content: m.content }));
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: userText,
                onboardingStep,
                parsedData,
                visaStatus,
                graduationTarget,
                history: recentHistory,
            }),
        });
        const data = await res.json();
        addMessage("assistant", data.message);
        if (data.onboardingStep) setOnboardingStep(data.onboardingStep);
        if (data.visaStatus) setVisaStatus(data.visaStatus);
        if (data.graduationTarget) setGraduationTarget(data.graduationTarget);
    };

    const handleSend = async () => {
        const text = input.trim();
        if (!text || isLoading) return;

        setInput("");
        addMessage("user", text);
        setIsLoading(true);

        try {
            // Onboarding turns and pre-transcript chitchat → legacy v1.
            // Post-onboarding (parsedData present + step=complete) → v2 SSE.
            const useV2 = onboardingStep === "complete" && parsedData;
            if (useV2) {
                await handleSendV2(text);
            } else {
                await handleSendV1(text);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Sorry, something went wrong. Please try again.";
            addMessage("assistant", msg);
        } finally {
            setIsLoading(false);
            inputRef.current?.focus();
        }
    };

    /**
     * Two-step profile-update confirm affordance (§7.2). Sends a
     * follow-up user message that asks the agent to invoke
     * `confirm_profile_update` with the pending id. The agent's
     * system prompt + tool schema route this through correctly.
     */
    const handleConfirmPending = async (pendingMutationId: string) => {
        if (isLoading) return;
        const text = `Yes, please apply the pending profile update (pendingMutationId="${pendingMutationId}").`;
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not confirm the update.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleFileUpload = useCallback(async (file: File) => {
        if (!file.name.toLowerCase().endsWith(".pdf")) {
            addMessage("assistant", "Please upload a PDF file (your Degree Progress Report).");
            return;
        }

        addMessage("user", `📎 Uploaded: ${file.name}`);
        setIsLoading(true);

        // Phase 7-E W2.1: primary path uploads under the "dpr" form
        // field. The route detects DPR vs transcript by field name;
        // if the deterministic DPR parser fails, the route returns
        // an error message and we surface it to the user, who can
        // then re-upload as a transcript via the fallback button.
        try {
            const fieldName = onboardingStep === "awaiting_transcript" ? "transcript" : "dpr";
            const formData = new FormData();
            formData.append(fieldName, file);

            const res = await fetch("/api/onboard", {
                method: "POST",
                body: formData,
            });
            const data = await res.json();

            addMessage("assistant", data.message);
            if (data.onboardingStep) setOnboardingStep(data.onboardingStep);
            if (data.parsedData) setParsedData(data.parsedData);
        } catch {
            addMessage("assistant", "I had trouble processing that file. Please try uploading again.");
        } finally {
            setIsLoading(false);
        }
    }, [onboardingStep]);

    const switchToTranscriptFallback = useCallback(() => {
        setOnboardingStep("awaiting_transcript");
        addMessage(
            "assistant",
            "OK — please upload your **unofficial transcript** PDF instead. From Albert: **Student Center → Academics → View Unofficial Transcript**, then save the page as PDF and drop it here.",
        );
    }, []);

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFileUpload(file);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const renderMarkdown = (text: string) => {
        return text
            .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.*?)\*/g, "<em>$1</em>")
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n/g, "<br />");
    };

    return (
        <div
            className={`${styles.chatPage} ${isDragOver ? styles.dragOver : ""}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
        >
            {/* Header */}
            <header className={styles.header}>
                <a href="/" className={styles.headerLogo}>🎓 NYU Path</a>
                <span className={styles.headerBadge}>AI Advisor</span>
            </header>

            {/* Phase 7-E W10.3 — persistent disclaimer banner.
                Required by §5 of PRIVACY.md. Reminds the student that
                this is an unofficial tool and they should verify with
                an NYU adviser before acting on any output. Stays
                visible at all times in the chat view. */}
            <div className={styles.disclaimerBanner} role="note">
                <span className={styles.disclaimerIcon} aria-hidden="true">⚠</span>
                <span>
                    AI advising assistant. <strong>Not a substitute for an academic adviser.</strong>{" "}
                    Verify all decisions with NYU advising before acting.
                </span>
                <button
                    type="button"
                    onClick={async () => {
                        await fetch("/api/auth/logout", { method: "POST" });
                        window.location.href = "/login";
                    }}
                    className={styles.logoutButton}
                    aria-label="Sign out"
                >
                    Sign out
                </button>
            </div>

            {/* Drag overlay */}
            {isDragOver && (
                <div className={styles.dropOverlay}>
                    <div className={styles.dropBox}>
                        <span className={styles.dropIcon}>📄</span>
                        <p>Drop your DPR PDF here</p>
                    </div>
                </div>
            )}

            {/* Messages */}
            <div className={styles.messages}>
                {messages.map((msg, i) => (
                    <div
                        key={msg.id}
                        className={`${styles.messageBubble} ${styles[msg.role]}`}
                        style={{ animationDelay: `${Math.min(i * 0.05, 0.3)}s` }}
                    >
                        {msg.role === "assistant" && (
                            <div className={styles.avatar}>🎓</div>
                        )}
                        <div className={styles.bubbleContent}>
                            {/* Live status pill — shown while the turn is in flight. */}
                            {msg.role === "assistant" && msg.startedAt && !msg.completedAt && !msg.failedAt && (
                                <div className={styles.statusPill}>
                                    <span className={styles.statusDot} />
                                    <span className={styles.statusVerb}>
                                        {currentVerbFor(msg.toolStatuses)}…
                                    </span>
                                </div>
                            )}
                            {/* Post-completion chip — shown after `done` arrives. */}
                            {msg.role === "assistant" && msg.startedAt && (msg.completedAt || msg.failedAt) && (
                                <div className={styles.statusChip}>
                                    <button
                                        type="button"
                                        className={styles.statusChipButton}
                                        onClick={() => updateMessage(msg.id, { traceExpanded: !msg.traceExpanded })}
                                        aria-expanded={!!msg.traceExpanded}
                                        disabled={!msg.toolStatuses || msg.toolStatuses.length === 0}
                                    >
                                        <span className={styles.statusChipLabel}>
                                            {msg.failedAt
                                                ? `Failed after ${formatDuration(msg.failedAt - msg.startedAt)}`
                                                : `Thought for ${formatDuration((msg.completedAt ?? Date.now()) - msg.startedAt)}`}
                                        </span>
                                        {msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                            <span className={styles.statusChipChevron}>
                                                {msg.traceExpanded ? "▾" : "▸"}
                                            </span>
                                        )}
                                    </button>
                                    {msg.traceExpanded && msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                        <ul className={styles.statusTrace}>
                                            {msg.toolStatuses.map((t, idx) => (
                                                <li key={idx} className={styles.statusTraceItem}>
                                                    <span className={styles.statusTraceIcon}>
                                                        {t.state === "running" ? "•" : t.state === "error" ? "⚠" : "✓"}
                                                    </span>
                                                    <span className={styles.statusTraceText}>
                                                        {getPastVerb(t.toolName)}
                                                        {t.error ? ` — ${t.error}` : ""}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}
                            <div
                                className={styles.bubbleText}
                                dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content || "") }}
                            />
                            {/* Validator block warning (§9.1 Part 9) */}
                            {msg.validatorViolations && msg.validatorViolations.length > 0 && (
                                <div style={{ fontSize: "0.85em", marginTop: 8, padding: 8, background: "#fff3cd", borderRadius: 6, color: "#664d03" }}>
                                    ⚠ <strong>Could not fully ground this reply.</strong>
                                    <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                                        {msg.validatorViolations.map((v, idx) => (
                                            <li key={idx}>
                                                <code>{v.kind}</code>
                                                {v.caveatId ? ` (${v.caveatId})` : ""}: {v.detail}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {/* Two-step profile-update confirm button (§7.2) */}
                            {msg.pendingMutationId && (
                                <button
                                    onClick={() => handleConfirmPending(msg.pendingMutationId!)}
                                    disabled={isLoading}
                                    style={{ marginTop: 8, padding: "6px 12px", borderRadius: 6, background: "#0d6efd", color: "white", border: "none", cursor: "pointer" }}
                                >
                                    Confirm profile update
                                </button>
                            )}
                        </div>
                    </div>
                ))}

                {isLoading && (
                    <div className={`${styles.messageBubble} ${styles.assistant}`}>
                        <div className={styles.avatar}>🎓</div>
                        <div className={styles.bubbleContent}>
                            <div className={styles.typing}>
                                <span></span><span></span><span></span>
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className={styles.inputArea}>
                <div className={styles.inputContainer}>
                    {(onboardingStep === "awaiting_dpr" || onboardingStep === "awaiting_transcript") && (
                        <button
                            className={styles.uploadBtn}
                            onClick={() => fileInputRef.current?.click()}
                            title={onboardingStep === "awaiting_dpr" ? "Upload Degree Progress Report PDF" : "Upload unofficial transcript PDF"}
                        >
                            📎
                        </button>
                    )}
                    <textarea
                        ref={inputRef}
                        className={styles.textInput}
                        placeholder={
                            onboardingStep === "awaiting_dpr"
                                ? "Upload your DPR (or type a message)…"
                                : onboardingStep === "awaiting_transcript"
                                ? "Upload your transcript (or type a message)…"
                                : "Type your message..."
                        }
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        rows={1}
                        disabled={isLoading}
                    />
                    <button
                        className={styles.sendBtn}
                        onClick={handleSend}
                        disabled={!input.trim() || isLoading}
                    >
                        ↑
                    </button>
                </div>
                {onboardingStep === "awaiting_dpr" && (
                    <button
                        className={styles.fallbackLink}
                        onClick={switchToTranscriptFallback}
                        type="button"
                    >
                        Can&rsquo;t access your DPR? Upload an unofficial transcript instead
                    </button>
                )}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    className={styles.hiddenFileInput}
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(file);
                        e.target.value = "";
                    }}
                />
            </div>
        </div>
    );
}
