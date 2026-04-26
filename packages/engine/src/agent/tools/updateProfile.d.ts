import { z } from "zod";
import { type PendingProfileMutation } from "../tool.js";
export declare const updateProfileTool: import("../tool.js").Tool<z.ZodDiscriminatedUnion<[z.ZodObject<{
    field: z.ZodLiteral<"homeSchool">;
    value: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    field: z.ZodLiteral<"catalogYear">;
    value: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    field: z.ZodLiteral<"declaredPrograms">;
    value: z.ZodArray<z.ZodObject<{
        programId: z.ZodString;
        programType: z.ZodEnum<{
            major: "major";
            minor: "minor";
            concentration: "concentration";
        }>;
        declaredAt: z.ZodOptional<z.ZodString>;
        declaredUnderCatalogYear: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    field: z.ZodLiteral<"visaStatus">;
    value: z.ZodEnum<{
        f1: "f1";
        domestic: "domestic";
        other: "other";
    }>;
}, z.core.$strip>], "field">, {
    status: "pending_confirmation";
    pendingMutationId: string;
    mutation: PendingProfileMutation;
}>;
export declare const confirmProfileUpdateTool: import("../tool.js").Tool<z.ZodObject<{
    pendingMutationId: z.ZodString;
}, z.core.$strip>, {
    status: "applied";
    mutation: PendingProfileMutation;
}>;
//# sourceMappingURL=updateProfile.d.ts.map