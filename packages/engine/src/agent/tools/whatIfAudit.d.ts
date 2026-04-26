import { z } from "zod";
export declare const whatIfAuditTool: import("../tool.js").Tool<z.ZodObject<{
    hypotheticalPrograms: z.ZodArray<z.ZodString>;
    compareWithCurrent: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>, import("../../audit/whatIfAudit.js").WhatIfResult>;
//# sourceMappingURL=whatIfAudit.d.ts.map