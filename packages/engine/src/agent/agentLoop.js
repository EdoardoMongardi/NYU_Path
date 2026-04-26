// ============================================================
// Agent Loop (Phase 5 §6.4)
// ============================================================
// Runs the model→tool→model cycle until the model emits a final
// text-only reply, max turns is reached, or the user aborts.
//
// Inspired by the Claude Code QueryEngine.submitMessage / query
// generators (referenced in the leaked recovered-src/src/QueryEngine.ts
// + query.ts). Trimmed for NYU Path scope:
//   - One model fallback (architecture's design decision #6)
//   - No subagent escalation, no MCP, no permission elicitation
//   - No streaming UI; the loop returns a final ChatTurn record
//
// Public surface:
//   runAgentTurn(client, registry, session, userMessage, options) →
//     ChatTurnResult
//
// The loop never throws on terminal conditions — it returns a
// `ChatTurnResult.kind` that disambiguates "ok" / "max_turns" /
// "aborted" / "model_error_no_fallback". Validation/runtime errors
// inside a tool are returned to the model as a `tool` message; the
// loop DOES NOT swallow them silently.
// ============================================================
/**
 * Run a single user message through the agent loop. Stateless w.r.t. the
 * client — the caller manages session/history persistence.
 */
export async function runAgentTurn(client, registry, session, userMessage, options) {
    const maxTurns = options.maxTurns ?? 10;
    const tools = toLLMToolDefs(registry, session);
    const conversation = [
        ...(options.priorMessages ?? []),
        { role: "user", content: userMessage },
    ];
    const turnMessages = [{ role: "user", content: userMessage }];
    const invocations = [];
    const totalUsage = { promptTokens: 0, completionTokens: 0 };
    let modelUsedId = client.id;
    for (let turn = 0; turn < maxTurns; turn++) {
        if (options.signal?.aborted) {
            return { kind: "aborted", invocations, turnMessages, modelUsedId };
        }
        const completionResult = await callWithFallback(client, options.fallbackClient, {
            system: options.systemPrompt,
            messages: conversation,
            tools,
            maxTokens: options.maxTokens ?? 1024,
            temperature: 0,
            signal: options.signal,
        });
        if (!completionResult.ok) {
            return {
                kind: "model_error_no_fallback",
                error: completionResult.error,
                invocations,
                turnMessages,
                modelUsedId,
            };
        }
        const completion = completionResult.completion;
        modelUsedId = completionResult.usedClientId;
        if (completion.usage?.promptTokens)
            totalUsage.promptTokens += completion.usage.promptTokens;
        if (completion.usage?.completionTokens)
            totalUsage.completionTokens += completion.usage.completionTokens;
        // Record assistant message into the running conversation
        const assistantMsg = {
            role: "assistant",
            content: completion.text,
            toolCalls: completion.toolCalls.length > 0 ? completion.toolCalls : undefined,
        };
        conversation.push(assistantMsg);
        turnMessages.push(assistantMsg);
        // No tool calls → final reply
        if (completion.toolCalls.length === 0) {
            return {
                kind: "ok",
                finalText: completion.text,
                invocations,
                turnMessages,
                usage: totalUsage,
                modelUsedId,
            };
        }
        // Execute every tool call in order. Tool errors are reported back
        // to the model so it can decide how to proceed.
        for (const tc of completion.toolCalls) {
            if (options.signal?.aborted) {
                return { kind: "aborted", invocations, turnMessages, modelUsedId };
            }
            const tool = registry.get(tc.name);
            if (!tool) {
                const msg = `Tool "${tc.name}" not found in registry. Available: ${registry.list().map((t) => t.name).join(", ")}`;
                pushToolMessage(conversation, turnMessages, tc.id, msg);
                invocations.push({ toolName: tc.name, args: tc.args, error: { message: msg } });
                continue;
            }
            const invocation = await executeTool(tool, tc, session, options.signal);
            invocations.push(invocation);
            const summary = invocation.summary ?? invocation.rejected?.userMessage
                ?? invocation.error?.message ?? "(no result)";
            pushToolMessage(conversation, turnMessages, tc.id, summary);
        }
    }
    return { kind: "max_turns", invocations, turnMessages, modelUsedId };
}
// ============================================================
// Helpers
// ============================================================
function pushToolMessage(conversation, turnMessages, toolCallId, content) {
    const msg = { role: "tool", content, toolCallId };
    conversation.push(msg);
    turnMessages.push(msg);
}
async function executeTool(tool, tc, session, signal) {
    const ctx = { signal: signal ?? new AbortController().signal, session };
    // Zod-validate the input
    const parsed = tool.inputSchema.safeParse(tc.args);
    if (!parsed.success) {
        return {
            toolName: tc.name,
            args: tc.args,
            error: {
                message: `Input validation failed for ${tc.name}: ` +
                    parsed.error.issues
                        .map((i) => `${i.path.join(".")}: ${i.message}`)
                        .join("; "),
            },
        };
    }
    // Tool-specific validation (e.g., "needs a profile loaded")
    if (tool.validateInput) {
        const v = await tool.validateInput(parsed.data, ctx);
        if (!v.ok) {
            return {
                toolName: tc.name,
                args: tc.args,
                rejected: { userMessage: v.userMessage },
            };
        }
    }
    const startedAt = Date.now();
    try {
        const out = await tool.call(parsed.data, ctx);
        const summary = tool.summarizeResult(out);
        return {
            toolName: tc.name,
            args: tc.args,
            summary,
            callMs: Date.now() - startedAt,
        };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
            toolName: tc.name,
            args: tc.args,
            error: { message: `Tool "${tc.name}" threw: ${message}` },
            callMs: Date.now() - startedAt,
        };
    }
}
async function callWithFallback(primary, fallback, args) {
    try {
        const completion = await primary.complete(args);
        return { ok: true, completion, usedClientId: primary.id };
    }
    catch (e) {
        const primaryErr = e instanceof Error ? e.message : String(e);
        if (!fallback) {
            return { ok: false, error: `Primary model "${primary.id}" errored: ${primaryErr}` };
        }
        try {
            const completion = await fallback.complete(args);
            return { ok: true, completion, usedClientId: fallback.id };
        }
        catch (e2) {
            const fbErr = e2 instanceof Error ? e2.message : String(e2);
            return {
                ok: false,
                error: `Primary "${primary.id}" errored: ${primaryErr}. ` +
                    `Fallback "${fallback.id}" errored: ${fbErr}`,
            };
        }
    }
}
/**
 * Convert the registry's tools into the vendor-neutral
 * `LLMToolDef` shape the LLMClient expects. Uses each tool's Zod
 * schema → JSON-schema-shaped `parameters`. Falls back to a permissive
 * object schema when the Zod schema can't be cleanly reflected.
 */
function toLLMToolDefs(registry, session) {
    return registry.list().map((tool) => ({
        name: tool.name,
        description: `${tool.description}\n\n${tool.prompt({ session })}`,
        parameters: zodToJsonSchema(tool.inputSchema),
    }));
}
/**
 * Minimal Zod → JSON-schema converter for the bakeoff/agent's tool
 * descriptors. Handles the shapes the 6 NYU Path tools use; falls back
 * to `{type:"object"}` for anything more exotic. Intentionally lightweight
 * — production should swap in `zod-to-json-schema` if richer shapes
 * appear.
 */
function zodToJsonSchema(schema) {
    const z = schema;
    const typeName = z._def?.typeName;
    if (typeName === "ZodObject") {
        const shape = z._def.shape();
        const properties = {};
        const required = [];
        for (const [k, v] of Object.entries(shape)) {
            const innerName = v._def?.typeName;
            const isOptional = innerName === "ZodOptional" || innerName === "ZodDefault";
            properties[k] = describeZodLeaf(v);
            if (!isOptional)
                required.push(k);
        }
        return { type: "object", properties, required, additionalProperties: false };
    }
    if (typeName === "ZodDiscriminatedUnion") {
        // For the update_profile tool — accept any object.
        return { type: "object" };
    }
    return { type: "object" };
}
function describeZodLeaf(v) {
    const z = v;
    const t = z._def?.typeName;
    if (t === "ZodOptional" || t === "ZodDefault")
        return describeZodLeaf(z._def.innerType);
    if (t === "ZodString")
        return { type: "string" };
    if (t === "ZodNumber")
        return { type: "number" };
    if (t === "ZodBoolean")
        return { type: "boolean" };
    if (t === "ZodArray")
        return { type: "array", items: describeZodLeaf(z._def.type) };
    if (t === "ZodEnum")
        return { type: "string" };
    return {};
}
//# sourceMappingURL=agentLoop.js.map