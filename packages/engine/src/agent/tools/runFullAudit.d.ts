import { z } from "zod";
export declare const runFullAuditTool: import("../tool.js").Tool<z.ZodObject<{
    programId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, {
    audits: import("@nyupath/shared").AuditResult[];
    standing: import("../../audit/academicStanding.js").StandingResult;
}>;
//# sourceMappingURL=runFullAudit.d.ts.map