// ============================================================
// /login — email-OTP entry (Phase 7-E W12.4)
// ============================================================
// Two-step flow on a single page:
//   Step 1: enter email → POST /api/auth/otp/issue
//   Step 2: enter 6-digit code → POST /api/auth/otp/verify
// On verify success, the cookie is set server-side and we
// router.push("/chat").
//
// No account distinction: every successful verify upserts a
// students row, so login = signup. Cohort A docs explain this
// (one-pager + privacy-doc).
// ============================================================

"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "./login.module.css";

type Step = "email" | "code";

export default function LoginPage() {
    const router = useRouter();
    const [step, setStep] = useState<Step>("email");
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [info, setInfo] = useState<string | null>(null);

    async function handleEmailSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setInfo(null);
        setBusy(true);
        try {
            const res = await fetch("/api/auth/otp/issue", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) {
                setError(j.error ?? "Couldn't send the code. Try again.");
                return;
            }
            setStep("code");
            setInfo(`We sent a 6-digit code to ${email}. It expires in 10 minutes.`);
        } catch {
            setError("Network error. Check your connection and try again.");
        } finally {
            setBusy(false);
        }
    }

    async function handleCodeSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const res = await fetch("/api/auth/otp/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, code }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) {
                setError(j.error ?? "Couldn't verify the code. Try again.");
                return;
            }
            router.push("/chat");
        } catch {
            setError("Network error. Check your connection and try again.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.page}>
            <div className={styles.card}>
                <h1 className={styles.title}>🎓 NYU Path</h1>
                <p className={styles.subtitle}>
                    Sign in with your <strong>@nyu.edu</strong> email.
                    We&apos;ll send you a one-time login code.
                </p>

                {step === "email" && (
                    <form onSubmit={handleEmailSubmit} className={styles.form}>
                        <label className={styles.label}>
                            Email
                            <input
                                type="email"
                                inputMode="email"
                                autoComplete="email"
                                placeholder="netid@nyu.edu"
                                value={email}
                                onChange={(ev) => setEmail(ev.target.value)}
                                required
                                disabled={busy}
                                className={styles.input}
                            />
                        </label>
                        <button type="submit" disabled={busy || !email} className={styles.button}>
                            {busy ? "Sending..." : "Send code"}
                        </button>
                    </form>
                )}

                {step === "code" && (
                    <form onSubmit={handleCodeSubmit} className={styles.form}>
                        <label className={styles.label}>
                            6-digit code
                            <input
                                type="text"
                                inputMode="numeric"
                                pattern="\d{6}"
                                autoComplete="one-time-code"
                                placeholder="123456"
                                value={code}
                                onChange={(ev) => setCode(ev.target.value.replace(/\D/g, "").slice(0, 6))}
                                required
                                disabled={busy}
                                className={styles.codeInput}
                            />
                        </label>
                        <button type="submit" disabled={busy || code.length !== 6} className={styles.button}>
                            {busy ? "Verifying..." : "Sign in"}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setStep("email"); setCode(""); setError(null); setInfo(null); }}
                            className={styles.linkButton}
                            disabled={busy}
                        >
                            ← Use a different email
                        </button>
                    </form>
                )}

                {info && <p className={styles.info}>{info}</p>}
                {error && <p className={styles.error}>{error}</p>}

                <p className={styles.privacy}>
                    By signing in you accept our{" "}
                    <a href="/PRIVACY.md" target="_blank" rel="noopener noreferrer">privacy posture</a>
                    {" "}— ephemeral DPR processing, no cross-session memory in cohort A.
                </p>
            </div>
        </div>
    );
}
