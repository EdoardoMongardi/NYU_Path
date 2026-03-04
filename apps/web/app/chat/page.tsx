"use client";

import { useState, useRef, useCallback } from "react";
import styles from "./chat.module.css";

interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
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

    const addMessage = (role: "user" | "assistant", content: string) => {
        const msg: Message = {
            id: Date.now().toString(),
            role,
            content,
            timestamp: new Date(),
        };
        setMessages(prev => [...prev, msg]);
        setTimeout(scrollToBottom, 100);
        return msg;
    };

    const handleSend = async () => {
        const text = input.trim();
        if (!text || isLoading) return;

        setInput("");
        addMessage("user", text);
        setIsLoading(true);

        try {
            // Send recent message history for conversational context
            const recentHistory = messages
                .filter(m => m.id !== "welcome")
                .slice(-10)
                .map(m => ({ role: m.role, content: m.content }));

            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: text,
                    onboardingStep,
                    parsedData,
                    visaStatus,
                    graduationTarget,
                    history: recentHistory,
                }),
            });
            const data = await res.json();

            addMessage("assistant", data.message);
            if (data.onboardingStep) {
                setOnboardingStep(data.onboardingStep);
            }
            // Capture visa and graduation answers from onboarding
            if (data.visaStatus) {
                setVisaStatus(data.visaStatus);
            }
            if (data.graduationTarget) {
                setGraduationTarget(data.graduationTarget);
            }
        } catch {
            addMessage("assistant", "Sorry, something went wrong. Please try again.");
        } finally {
            setIsLoading(false);
            inputRef.current?.focus();
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
            if (data.onboardingStep) {
                setOnboardingStep(data.onboardingStep);
            }
            // Store parsed transcript data for later chat API calls
            if (data.parsedData) {
                setParsedData(data.parsedData);
            }
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
        // Simple markdown rendering
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
                            <div
                                className={styles.bubbleText}
                                dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                            />
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
