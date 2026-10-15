import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { resolveAgentModelSelection } from "@/composer/agent-controls/utils";

export interface AgentFactsInput {
  models: AgentModelDefinition[] | null;
  runtimeModelId: string | null | undefined;
  configuredModelId: string | null | undefined;
  runtimeThinkingOptionId: string | null | undefined;
  explicitThinkingOptionId: string | null | undefined;
}

/**
 * The model and thinking a Paseo agent runs with, as one line, resolved exactly as the composer's
 * model and thinking controls resolve them. Null until the agent has a model at all.
 */
export function buildAgentFactsLine(input: AgentFactsInput): string | null {
  const hasModel = Boolean(input.runtimeModelId?.trim() || input.configuredModelId?.trim());
  if (!hasModel) return null;
  const selection = resolveAgentModelSelection(input);
  const parts = [selection.displayModel];
  if (selection.selectedThinkingId) parts.push(selection.displayThinking);
  return parts.join(" · ");
}
