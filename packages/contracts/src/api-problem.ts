import { z } from "zod";

export const requestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const apiProblemIssueSchema = z.object({
  path: z.string(),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const apiProblemSchema = z.object({
  type: z.string().url(),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1),
  instance: z.string().optional(),
  code: z.string().min(1),
  requestId: requestIdSchema,
  error: z.string().min(1),
  violations: z.array(z.string()).optional(),
  issues: z.array(apiProblemIssueSchema).optional(),
}).passthrough();

export type ApiProblemIssue = z.infer<typeof apiProblemIssueSchema>;
export type ApiProblem = z.infer<typeof apiProblemSchema>;
