import { z } from "zod";
import { promptVariableSchema } from "./job.js";

export const createPromptSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(50)).default([]),
  content: z.string().min(1), // initial PromptVersion content
  variables: z.array(promptVariableSchema).default([]),
});
export type CreatePromptInput = z.infer<typeof createPromptSchema>;

export const updatePromptSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(50)).optional(),
});
export type UpdatePromptInput = z.infer<typeof updatePromptSchema>;

export const createPromptVersionSchema = z.object({
  content: z.string().min(1),
  variables: z.array(promptVariableSchema).default([]),
});
export type CreatePromptVersionInput = z.infer<typeof createPromptVersionSchema>;
