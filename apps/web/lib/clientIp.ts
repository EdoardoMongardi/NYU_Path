// ============================================================
// Client IP for rate-limit bucketing
// ============================================================
// Trust model: the production target is Vercel. Vercel sets
// `x-vercel-forwarded-for` to the client's public IP and OVERWRITES
// `x-forwarded-for` / `x-real-ip` ("to prevent IP spoofing" —
// https://vercel.com/docs/headers/request-headers), so on Vercel a
// client cannot choose its own bucket. `x-vercel-forwarded-for` is
// preferred because it survives a proxy placed in front of Vercel.
//
// We only read the Vercel header when `VERCEL` is set (Vercel exposes
// `VERCEL=1` at runtime); off Vercel a client could send it.
//
// Off Vercel (local dev, a self-host with no overwriting proxy) every
// header below is client-controlled, so an IP bucket is a speed bump,
// not a control. We deliberately do NOT switch to the rightmost XFF
// hop: behind a multi-proxy chain that would collapse every user onto
// the nearest proxy's IP and let one caller lock everyone out.
// ============================================================

interface HeaderReader {
    get(name: string): string | null;
}

function firstHop(value: string | null): string | null {
    const hop = value?.split(",")[0]?.trim();
    return hop ? hop : null;
}

export function clientIp(
    headers: HeaderReader,
    env: Record<string, string | undefined> = process.env,
): string {
    if (env.VERCEL) {
        const vercel = firstHop(headers.get("x-vercel-forwarded-for"));
        if (vercel) return vercel;
    }
    return firstHop(headers.get("x-forwarded-for"))
        ?? firstHop(headers.get("x-real-ip"))
        ?? "anonymous";
}
