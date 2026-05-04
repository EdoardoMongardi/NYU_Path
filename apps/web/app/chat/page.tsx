"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import styles from "./chat.module.css";
import { streamChatV2, extractPendingMutationId, type ChatV2Event } from "../../lib/chatV2Client";
import { getPastVerb, getThoughtSentence } from "../../lib/agentStatusVerbs";
import { formatDuration } from "../../lib/formatDuration";
import type { ForwardSchedule } from "@nyupath/shared";
import ScheduleSidebar from "./scheduleSidebar";

// Char-reveal rates for the ChatGPT-style typewriter animations.
// Tuned by feel: thinking should read like deliberative reasoning;
// the final answer should feel snappy, like ChatGPT post-token.
const THINKING_CHARS_PER_SEC = 60;
const CONTENT_CHARS_PER_SEC = 220;

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
    /** Agent-status UX: whether the user has expanded the reasoning block. */
    traceExpanded?: boolean;
    /** Reasoning text that streams above the final answer. Holds real
     *  Anthropic chain-of-thought when `hasRealThinking` is set,
     *  otherwise a fallback of synthesized tool-sentence narration
     *  (one sentence per tool fired). */
    thinkingText?: string;
    /** How many chars of `thinkingText` are currently revealed
     *  (typewriter animation; ticker bumps this up over time). */
    thinkingRevealed?: number;
    /** How many chars of `content` are currently revealed in the
     *  final-answer bubble. Drives the ChatGPT-style streaming. */
    contentRevealed?: number;
    /** True once at least one `thinking` SSE event has fired for this
     *  message. When set, suppresses the synthesized tool-thought
     *  fallback so we don't double-narrate (real reasoning + canned
     *  sentences). Stays unset on OpenAI-fallback turns and template-
     *  match recovery, where the synthesized fallback is what the
     *  user sees. */
    hasRealThinking?: boolean;
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

function isInFlight(m: Message): boolean {
    return m.role === "assistant" && !!m.startedAt && !m.completedAt && !m.failedAt;
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
    const [forwardSchedule, setForwardSchedule] = useState<ForwardSchedule | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    /**
     * Single rAF-driven typewriter ticker. Walks the messages array
     * each frame and bumps `thinkingRevealed` / `contentRevealed`
     * forward by `rate * elapsed` chars. Once the message is
     * `completedAt` / `failedAt`, thinking snaps to full and content
     * starts streaming. All reveal counters are clamped at the full
     * length, so a settled message renders as a no-op.
     */
    useEffect(() => {
        let raf = 0;
        let lastTime = performance.now();
        const tick = (now: number) => {
            const elapsed = Math.min(100, now - lastTime); // clamp to avoid huge jumps after tab-switch
            lastTime = now;
            setMessages(prev => {
                let changed = false;
                const next = prev.map(m => {
                    if (m.role !== "assistant" || !m.startedAt) return m;
                    const thinkingFull = (m.thinkingText ?? "").length;
                    const contentFull = (m.content ?? "").length;
                    const tRev = m.thinkingRevealed ?? 0;
                    const cRev = m.contentRevealed ?? 0;

                    let newT = tRev;
                    let newC = cRev;

                    if (m.completedAt || m.failedAt) {
                        // Once a turn is settled, snap thinking to full
                        // immediately and let the content typewriter run.
                        newT = thinkingFull;
                        if (m.failedAt) {
                            newC = contentFull;
                        } else if (cRev < contentFull) {
                            const step = Math.max(1, Math.round(CONTENT_CHARS_PER_SEC * elapsed / 1000));
                            newC = Math.min(contentFull, cRev + step);
                        }
                    } else if (tRev < thinkingFull) {
                        const step = Math.max(1, Math.round(THINKING_CHARS_PER_SEC * elapsed / 1000));
                        newT = Math.min(thinkingFull, tRev + step);
                    }

                    if (newT !== tRev || newC !== cRev) {
                        changed = true;
                        return { ...m, thinkingRevealed: newT, contentRevealed: newC };
                    }
                    return m;
                });
                return changed ? next : prev;
            });
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

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
        updateMessage(assistant.id, {
            startedAt: Date.now(),
            thinkingText: "",
            thinkingRevealed: 0,
            contentRevealed: 0,
        });
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
            case "tool_invocation_start": {
                toolStatuses.push({ toolName: ev.toolName, state: "running" });
                const sentence = getThoughtSentence(ev.toolName);
                setMessages(prev => prev.map(m => {
                    if (m.id !== assistantId) return m;
                    // When the real model is producing a chain-of-thought,
                    // the synthesized tool-sentence narration would just
                    // duplicate / contradict the model's words. Skip it.
                    if (m.hasRealThinking) {
                        return { ...m, toolStatuses: [...toolStatuses] };
                    }
                    return {
                        ...m,
                        toolStatuses: [...toolStatuses],
                        thinkingText: ((m.thinkingText ?? "") + (m.thinkingText ? "\n\n" : "") + sentence),
                    };
                }));
                break;
            }
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
            case "thinking":
                setMessages(prev => prev.map(m => {
                    if (m.id !== assistantId) return m;
                    if (!m.hasRealThinking) {
                        // Phase 13 §8c — first real thinking event. The
                        // synthesized tool-sentence narration (if any) was
                        // a fallback; real reasoning replaces it. Clear and
                        // start fresh so the user doesn't see both.
                        return {
                            ...m,
                            thinkingText: ev.text,
                            thinkingRevealed: 0, // restart the typewriter on the new text
                            hasRealThinking: true,
                        };
                    }
                    return {
                        ...m,
                        thinkingText: (m.thinkingText ?? "") + ev.text,
                        hasRealThinking: true,
                    };
                }));
                break;
            case "forward_schedule_update":
                setForwardSchedule(ev.schedule);
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
     * Phase 14 Task 10 — Load-style proposal.
     * Injects a user-visible chat message asking the agent to call
     * `propose_plan_change` with the requested load style. The agent's
     * tool-use behavior handles the round-trip from here.
     */
    const handleProposeLoadStyle = async (style: "balanced" | "frontload" | "backload") => {
        if (isLoading) return;
        const text = `Please propose a ${style} load style for my schedule — call propose_plan_change with loadStyle="${style}".`;
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not propose load style change.");
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Phase 14 Task 10 — Slot-level change proposal.
     * Injects a user-visible chat message describing the desired
     * slot mutation. The agent's tool-use behavior routes the call
     * to `propose_plan_change` with appropriate args.
     */
    const handleProposeSlotChange = async (
        slot: import("@nyupath/shared").ScheduleSlot,
        action: "lock" | "replace" | "drop" | "pin",
    ) => {
        if (isLoading) return;
        const slotId =
            slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress"
                ? slot.courseId
                : `placeholder(${slot.category})`;
        const actionText: Record<string, string> = {
            lock: `lock the slot for ${slotId} as-is`,
            replace: `replace the slot for ${slotId} with a different course`,
            drop: `drop the slot for ${slotId}`,
            pin: `pin ${slotId} to a different term`,
        };
        const text = `Please ${actionText[action]} — call propose_plan_change with the appropriate args for this change.`;
        addMessage("user", text);
        setIsLoading(true);
        try {
            await handleSendV2(text);
        } catch (err) {
            addMessage("assistant", err instanceof Error ? err.message : "Could not propose slot change.");
        } finally {
            setIsLoading(false);
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
                {/* Phase 13 Task 9 — show the schedule toggle only after the
                    solver has produced a forward plan; before that there's
                    nothing to reveal and the affordance would be confusing. */}
                {forwardSchedule !== null && (
                    <button
                        type="button"
                        className={styles.scheduleToggle}
                        onClick={() => setSidebarOpen(o => !o)}
                        aria-label="Toggle schedule sidebar"
                        aria-expanded={sidebarOpen}
                    >
                        📅 Schedule
                    </button>
                )}
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
                            {/* Reasoning block — header + indented thinking text.
                                Live: shimmering "Thinking" with streaming sentences.
                                Done: "Reasoned for Xs" / "Failed after Xs", click to toggle. */}
                            {msg.role === "assistant" && msg.startedAt && (() => {
                                const settled = msg.completedAt || msg.failedAt;
                                const inFlight = !settled;
                                const headerText = msg.failedAt
                                    ? `Failed after ${formatDuration(msg.failedAt - msg.startedAt)}`
                                    : settled
                                    ? `Reasoned for ${formatDuration((msg.completedAt ?? Date.now()) - msg.startedAt)}`
                                    : "Thinking";
                                const expanded = inFlight ? true : !!msg.traceExpanded;
                                const visibleThought = (msg.thinkingText ?? "").slice(0, msg.thinkingRevealed ?? 0);
                                const hasAnyThought = (msg.thinkingText ?? "").length > 0;
                                return (
                                    <div className={styles.reasoning}>
                                        {settled ? (
                                            <button
                                                type="button"
                                                className={styles.reasoningHeader}
                                                onClick={() => updateMessage(msg.id, { traceExpanded: !msg.traceExpanded })}
                                                aria-expanded={!!msg.traceExpanded}
                                                aria-controls={`reasoning-${msg.id}`}
                                                disabled={!hasAnyThought}
                                            >
                                                <span className={styles.reasoningHeaderText}>{headerText}</span>
                                                {hasAnyThought && (
                                                    <span className={styles.reasoningChevron} aria-hidden="true">
                                                        {msg.traceExpanded ? "▾" : "▸"}
                                                    </span>
                                                )}
                                            </button>
                                        ) : (
                                            <div
                                                className={`${styles.reasoningHeader} ${styles.reasoningHeaderActive}`}
                                                role="status"
                                                aria-live="polite"
                                            >
                                                <span className={styles.reasoningHeaderText}>{headerText}</span>
                                            </div>
                                        )}
                                        {expanded && hasAnyThought && (
                                            <div
                                                id={`reasoning-${msg.id}`}
                                                className={styles.reasoningBody}
                                            >
                                                {visibleThought.split("\n\n").map((para, idx) => (
                                                    <p key={idx} className={styles.reasoningParagraph}>
                                                        {para}
                                                        {inFlight && idx === visibleThought.split("\n\n").length - 1 && (
                                                            <span className={styles.reasoningCaret} aria-hidden="true" />
                                                        )}
                                                    </p>
                                                ))}
                                                {msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                                    <ul className={styles.reasoningToolList}>
                                                        {msg.toolStatuses.map((t, idx) => (
                                                            <li key={idx} className={styles.reasoningToolItem}>
                                                                <span className={styles.reasoningToolIcon}>
                                                                    {t.state === "running" ? "•" : t.state === "error" ? "⚠" : "✓"}
                                                                </span>
                                                                <span className={styles.reasoningToolText}>
                                                                    {getPastVerb(t.toolName)}
                                                                    {t.error ? ` — ${t.error}` : ""}
                                                                </span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                            {/* Final-answer bubble. Hidden while empty so we don't render
                                an empty white card while the agent is still thinking. */}
                            {(() => {
                                const isV2 = msg.role === "assistant" && !!msg.startedAt;
                                const text = isV2
                                    ? (msg.content ?? "").slice(0, msg.contentRevealed ?? 0)
                                    : (msg.content ?? "");
                                if (!text) return null;
                                const inFlight = isV2 && !msg.completedAt && !msg.failedAt;
                                return (
                                    <div
                                        className={styles.bubbleText}
                                        dangerouslySetInnerHTML={{
                                            __html: renderMarkdown(text) + (inFlight ? "" : ""),
                                        }}
                                    />
                                );
                            })()}
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

                {/* Legacy v1 loader — only shown for onboarding turns
                    that go through the JSON `/api/chat` route (which
                    has no SSE indicator of its own). v2 turns get
                    their reasoning header + streaming block instead. */}
                {isLoading && !(onboardingStep === "complete" && parsedData) && (
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
            <ScheduleSidebar
                schedule={forwardSchedule}
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                onProposeLoadStyle={handleProposeLoadStyle}
                onProposeSlotChange={handleProposeSlotChange}
            />
        </div>
    );
}
