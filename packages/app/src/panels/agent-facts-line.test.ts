import { describe, expect, it } from "vitest";
import { buildAgentFactsLine } from "./agent-facts-line";

const models = [
  {
    provider: "claude",
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    thinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
  },
];

describe("buildAgentFactsLine", () => {
  it("joins the resolved model label and thinking label", () => {
    expect(
      buildAgentFactsLine({
        models,
        runtimeModelId: "claude-fable-5-1",
        configuredModelId: null,
        runtimeThinkingOptionId: "high",
        explicitThinkingOptionId: null,
      }),
    ).toBe("Fable 5.1 · High");
  });

  it("shows the raw model id before the catalog has loaded", () => {
    expect(
      buildAgentFactsLine({
        models: null,
        runtimeModelId: null,
        configuredModelId: "gpt-6.1-sol",
        runtimeThinkingOptionId: null,
        explicitThinkingOptionId: "medium",
      }),
    ).toBe("gpt-6.1-sol · Medium");
  });

  it("leaves thinking out when the agent has none", () => {
    expect(
      buildAgentFactsLine({
        models: [{ provider: "mock", id: "m", label: "Model M" }],
        runtimeModelId: "m",
        configuredModelId: null,
        runtimeThinkingOptionId: null,
        explicitThinkingOptionId: null,
      }),
    ).toBe("Model M");
  });

  it("is empty until the agent has a model", () => {
    expect(
      buildAgentFactsLine({
        models,
        runtimeModelId: null,
        configuredModelId: " ",
        runtimeThinkingOptionId: null,
        explicitThinkingOptionId: null,
      }),
    ).toBeNull();
  });
});
