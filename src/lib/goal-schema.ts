import { z } from "zod";

/** Shared model/tool validation; contains no store or account state. */
export const goalMetadataPatchSchema=z.object({topic:z.string().trim().min(1).max(120).optional(),direction:z.string().max(1000).optional(),motivation:z.string().max(3000).optional(),background:z.string().max(5000).optional(),weeklyHours:z.number().min(0.5).max(100).optional(),status:z.enum(["active","paused"]).optional()}).strict();
