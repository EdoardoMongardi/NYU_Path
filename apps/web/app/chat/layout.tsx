// ============================================================
// /chat layout — Phase 7-E W12.5 auth gate
// ============================================================
// Server Component that redirects unauthenticated requests to
// /login. The cookie check happens before any client JS runs,
// so a logged-out user never even sees the chat shell.
//
// Why a layout instead of middleware: middleware runs in the
// edge runtime which can't import node:crypto (which jose uses
// under the hood for HS256 verify). Layout runs in the same
// Node runtime as the chat route — keeps the auth code in one
// place.
// ============================================================

import { redirect } from "next/navigation";
import { readSessionFromCookies } from "../../lib/auth/session";

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
    const session = await readSessionFromCookies();
    if (!session) redirect("/login");
    return <>{children}</>;
}
