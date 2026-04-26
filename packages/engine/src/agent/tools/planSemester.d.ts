import { z } from "zod";
export declare const planSemesterTool: import("../tool.js").Tool<z.ZodObject<{
    targetSemester: z.ZodString;
    maxCourses: z.ZodOptional<z.ZodNumber>;
    maxCredits: z.ZodOptional<z.ZodNumber>;
    programId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, import("@nyupath/shared").SemesterPlan>;
//# sourceMappingURL=planSemester.d.ts.map