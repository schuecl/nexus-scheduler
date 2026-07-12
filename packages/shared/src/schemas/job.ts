import { z } from "zod";

export const createJobSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(200),
  promptId: z.string().uuid(),
  agentId: z.string().min(1), // LibreChat agent ID (REQUIREMENTS §2.1)
  apiKeyId: z.string().uuid(),
  timeoutSeconds: z.number().int().min(1).max(3600).default(600), // 10m default, 60m ceiling
  maxRetries: z.number().int().min(0).max(5).default(2),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;

// {{variable}} placeholders declared on a prompt version — REQUIREMENTS §2.3.
export const promptVariableSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(["text", "number", "date"]),
  defaultValue: z.string().optional(),
});

export type PromptVariable = z.infer<typeof promptVariableSchema>;
