"use client";

import { useState, useRef, useCallback } from "react";
import styles from "./chat.module.css";
import { streamChatV2, extractPendingMutationId, type ChatV2Event } from "../../lib/chatV2Client";

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
}

type OnboardingStep = "awaiting_transcript" | "confirming_data" | "correcting_data" | "asking_visa" | "asking_graduation" | "complete" | "unsupported_major";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ParsedTranscript = Record<string, any>;

const WELCOME_MESSAGE: Message = {
    id: "welcome",
    role: "assistant",
    content: `Welcome to **NYU Path** 🎓\n\nI'll help you plan your courses and track your degree progress.\n\nTo get started, please upload your **unofficial transcript PDF**. You can download it from Albert → Student Center → Academics → View Unofficial Transcript.\n\n📎 Just drag & drop or click below to upload!`,
    timestamp: new Date(),
};

export default function ChatPage() {
    const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>("awaiting_transcript");
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
        const toolStatuses: ToolStatus[] = [];

        for await (const ev of streamChatV2({
            message: userText,
            parsedData,
            visaStatus,
            history: recentHistory,
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
                updateMessage(assistantId, { content: ev.finalText });
                break;
            case "error":
                updateMessage(assistantId, {
                    content: (assistantId && messages.find(m => m.id === assistantId)?.content) || `Sorry — something went wrong: ${ev.message}`,
                });
                break;
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
        if (!file.name.endsWith(".pdf")) {
            addMessage("assistant", "Please upload a PDF file (your unofficial transcript).");
            return;
        }

        addMessage("user", `📎 Uploaded: ${file.name}`);
        setIsLoading(true);

        try {
            const formData = new FormData();
            formData.append("transcript", file);

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

            {/* Drag overlay */}
            {isDragOver && (
                <div className={styles.dropOverlay}>
                    <div className={styles.dropBox}>
                        <span className={styles.dropIcon}>📄</span>
                        <p>Drop your transcript PDF here</p>
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
                            {/* Tool-invocation log (Phase 6.5 P-1) */}
                            {msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                <div className={styles.toolLog ?? ""} style={{ fontSize: "0.85em", opacity: 0.7, marginBottom: 6 }}>
                                    {msg.toolStatuses.map((t, idx) => (
                                        <div key={idx}>
                                            {t.state === "running" && <>⏳ running <code>{t.toolName}</code>…</>}
                                            {t.state === "done" && <>✓ <code>{t.toolName}</code></>}
                                            {t.state === "error" && <>⚠ <code>{t.toolName}</code> — {t.error}</>}
                                        </div>
                                    ))}
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
                    {onboardingStep === "awaiting_transcript" && (
                        <button
                            className={styles.uploadBtn}
                            onClick={() => fileInputRef.current?.click()}
                            title="Upload transcript PDF"
                        >
                            📎
                        </button>
                    )}
                    <textarea
                        ref={inputRef}
                        className={styles.textInput}
                        placeholder={
                            onboardingStep === "awaiting_transcript"
                                ? "Upload your transcript or type a message..."
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
