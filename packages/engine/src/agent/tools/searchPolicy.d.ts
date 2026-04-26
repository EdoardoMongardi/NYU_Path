import { z } from "zod";
export declare const searchPolicyTool: import("../tool.js").Tool<z.ZodObject<{
    query: z.ZodString;
}, z.core.$strip>, {
    transferIntent: boolean;
    kind: "template" | "rag" | "escalate";
    template?: import("../../rag/policyTemplate.js").TemplateMatchResult;
    hits?: import("../../rag/reranker.js").RerankedHit[];
    confidence: import("../../rag/policySearch.js").ConfidenceBand;
    scopedSchools: string[];
    overrideTriggered: boolean;
    candidateCount: number;
    notes: string[];
}>;
//# sourceMappingURL=searchPolicy.d.ts.map