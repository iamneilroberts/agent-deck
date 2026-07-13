// Request-body Zod schemas. Reuses shared domain schemas (`AgentKindSchema`) where the wire
// shape matches the domain type exactly, so a request accepting an unsupported `agentKind`
// fails validation the same way the store would reject it.
import { z } from "zod";
import { AgentKindSchema } from "@agentdeck/shared";

export const LoginBodySchema = z.object({
  password: z.string().min(1),
});

export const CreateProjectBodySchema = z.object({
  name: z.string().min(1),
  repositoryPath: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
});

export const CreateSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  agentKind: AgentKindSchema,
  workingDirectory: z.string().min(1),
  prompt: z.string().optional(),
  model: z.string().optional(),
});

export const MessageBodySchema = z.object({
  text: z.string().min(1),
});

export const ResolveApprovalBodySchema = z.object({
  sessionId: z.string().uuid(),
  optionId: z.string().min(1),
  note: z.string().optional(),
  updatedInput: z.unknown().optional(),
});

export const RespondInputRequestBodySchema = z.object({
  sessionId: z.string().uuid(),
  response: z.string(),
});
