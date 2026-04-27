// ============================================================
// Embedder Interface + Deterministic Test Embedder (Phase 4 §5.1)
// ============================================================
// The embedder converts text → fixed-length vector. Production wires
// this to OpenAI/Cohere/Voyage; tests use the deterministic hash-based
// `LocalHashEmbedder` so the entire pipeline runs without network.
//
// The deterministic embedder is NOT a stub — it's a real bag-of-words
// hashed-feature vectorizer. It produces stable, reproducible outputs
// and gives meaningful cosine similarity for queries that share rare
// terms with chunks (the property the RAG layer needs at runtime).
// Resolution is lower than a real semantic embedder, so in production
// the LocalHashEmbedder MUST be replaced — but the interface contract
// is the same, and the rest of the pipeline doesn't care.
// ============================================================

export interface Embedder {
    /** Embedding dimensionality (must be constant) */
    readonly dim: number;
    /** Stable identifier for cache invalidation, e.g., "openai:text-embedding-3-small" */
    readonly modelId: string;
    embed(text: string): Promise<Float32Array>;
    embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Deterministic bag-of-hashed-features embedder. Used in tests; the
 * production runtime should swap in a real semantic embedder behind
 * the same interface.
 *
 * Method:
 *   1. Tokenize: lowercase, strip non-alphanumeric, split on whitespace
 *   2. For each token, compute fnv1a32(token) % dim → bucket index
 *   3. Increment bucket by IDF-style log(1 + frequency)
 *   4. L2-normalize the resulting vector
 *
 * This gives queries that share rare terms a high cosine similarity to
 * the matching chunk, and dissimilar texts low similarity. Good enough
 * for the test path; not good enough for production semantic match.
 */
export class LocalHashEmbedder implements Embedder {
    public readonly dim: number;
    public readonly modelId: string;

    constructor(dim = 256) {
        this.dim = dim;
        this.modelId = `local-hash-${dim}`;
    }

    async embed(text: string): Promise<Float32Array> {
        return this.embedSync(text);
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return texts.map((t) => this.embedSync(t));
    }

    embedSync(text: string): Float32Array {
        const v = new Float32Array(this.dim);
        const tokens = tokenize(text);
        const counts = new Map<string, number>();
        for (const t of tokens) {
            counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        for (const [t, c] of counts) {
            const bucket = fnv1a32(t) % this.dim;
            v[bucket] = (v[bucket] ?? 0) + Math.log(1 + c);
        }
        return l2Normalize(v);
    }
}

/**
 * OpenAI Embeddings adapter (Phase 7-B Step 3 / locked decision #3).
 * Used for both course-description embeddings AND policy chunks once
 * step 12 swaps in for `LocalHashEmbedder` as the production default.
 *
 * Cost: text-embedding-3-small is $0.02 / 1M input tokens — embedding
 * the full course corpus (17,122 × ~80 tokens) costs ~$0.03.
 *
 * Concurrency: the OpenAI embeddings API accepts up to 2048 inputs
 * per request. We batch at 100/request to keep latency predictable.
 *
 * Test mode: the constructor accepts `apiKey: ''` only when an
 * `injectedClient` is also passed; production callers should always
 * pass a real key.
 */
export class OpenAIEmbedder implements Embedder {
    public readonly dim: number;
    public readonly modelId: string;
    private readonly apiKey: string;
    private readonly model: string;
    private readonly injectedClient?: { embeddings: { create(args: { model: string; input: string[] }): Promise<{ data: Array<{ embedding: number[] }> }> } };

    constructor(opts: {
        apiKey: string;
        model?: string;
        injectedClient?: OpenAIEmbedder["injectedClient"];
    }) {
        this.apiKey = opts.apiKey;
        this.model = opts.model ?? "text-embedding-3-small";
        // text-embedding-3-small is 1536-dim; 3-large is 3072.
        this.dim = this.model === "text-embedding-3-large" ? 3072 : 1536;
        this.modelId = `openai:${this.model}`;
        this.injectedClient = opts.injectedClient;
    }

    async embed(text: string): Promise<Float32Array> {
        const [v] = await this.embedBatch([text]);
        return v!;
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        const client = this.injectedClient ?? (await this.lazyOpenAIClient());
        const out: Float32Array[] = [];
        const BATCH = 100;
        for (let i = 0; i < texts.length; i += BATCH) {
            const slice = texts.slice(i, i + BATCH);
            const response = await client.embeddings.create({
                model: this.model,
                input: slice,
            });
            for (const row of response.data) {
                const arr = new Float32Array(row.embedding);
                out.push(l2Normalize(arr));
            }
        }
        return out;
    }

    private async lazyOpenAIClient(): Promise<NonNullable<OpenAIEmbedder["injectedClient"]>> {
        // Lazy import so the engine doesn't pull `openai` into the
        // bundle when callers stay on `LocalHashEmbedder`.
        const mod = await import("openai");
        const OpenAI = mod.default ?? mod;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new (OpenAI as any)({ apiKey: this.apiKey });
    }
}

/** Compute cosine similarity between two unit-length vectors. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        throw new Error(`cosineSim: vector dim mismatch (${a.length} vs ${b.length})`);
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
    return dot;
}

// ---- helpers ----

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s/-]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2);
}

function fnv1a32(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

function l2Normalize(v: Float32Array): Float32Array {
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) * (v[i] ?? 0);
    const norm = Math.sqrt(sum);
    if (norm === 0) return v;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / norm;
    return out;
}
