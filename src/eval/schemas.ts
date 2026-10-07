import { z } from "zod";

const ObservationTypeEnum = z.enum([
  "file_read",
  "file_write",
  "file_edit",
  "command_run",
  "search",
  "web_fetch",
  "conversation",
  "error",
  "decision",
  "discovery",
  "subagent",
  "notification",
  "task",
  "other",
]);

export const CompressOutputSchema = z.object({
  type: ObservationTypeEnum,
  title: z.string().min(1).max(120),
  subtitle: z.string().optional(),
  facts: z.array(z.string()).min(1),
  narrative: z.string().min(10),
  concepts: z.array(z.string()),
  files: z.array(z.string()),
  importance: z.number().int().min(1).max(10),
});

export const SummaryOutputSchema = z.object({
  title: z.string().min(1),
  narrative: z.string().min(20),
  keyDecisions: z.array(z.string()),
  filesModified: z.array(z.string()),
  concepts: z.array(z.string()),
});
