// ============================================================
// Observability barrel (Phase 6 WS4)
// ============================================================
export {
    InMemoryFallbackSink,
    JsonlFileSink,
    NULL_SINK,
    defaultProductionSink,
    emitFallback,
} from "./fallbackLog.js";
export type {
    FallbackEvent,
    FallbackEventKind,
    FallbackSink,
} from "./fallbackLog.js";
