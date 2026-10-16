import { z } from "zod";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "../types";
import { transformTimelineItem } from "./model";

function plugin(input: {
  id: string;
  transform: InstalledPlugin["timelineTransformers"][number]["transform"];
}): InstalledPlugin {
  return {
    id: input.id,
    serverId: "host-1",
    clientBundle: "bundle",
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineSourceTransformers: [],
    timelineTransformers: [
      {
        id: "report",
        query: { itemType: "tool_call" },
        transform: input.transform as Extract<
          InstalledPlugin["timelineTransformers"][number],
          { query: { itemType: "tool_call" } }
        >["transform"],
      },
    ],
    timelineRenderers: [],
  };
}

const toolCall = {
  type: "tool_call" as const,
  callId: "call-1",
  name: "shell",
  detail: { type: "unknown" as const, input: null, output: null },
  status: "completed" as const,
  error: null,
};

describe("plugin timeline transforms", () => {
  it("adds installation and source identity to plain transformed items", () => {
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      agentId: "agent-1",
      plugins: [
        plugin({
          id: "reports",
          transform: () => ({
            items: [
              {
                type: "plugin" as const,
                kind: "test-report",
                version: 1,
                data: { passed: 4 },
              },
            ],
          }),
        }),
      ],
    });

    expect(transformed).toEqual([
      {
        type: "plugin",
        id: "agent_tool_call-1/0",
        pluginId: "reports",
        kind: "test-report",
        version: 1,
        data: { passed: 4 },
      },
    ]);
  });

  it("keeps the source item when no transformer returns a result", () => {
    expect(
      transformTimelineItem({
        item: toolCall,
        phase: "complete",
        sourceId: "agent_tool_call-1",
        agentId: "agent-1",
        plugins: [plugin({ id: "reports", transform: () => undefined })],
      }),
    ).toBeUndefined();
  });

  it("accepts an empty replacement and stops after the first result", () => {
    const second = vi.fn(() => ({ items: [] }));
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      agentId: "agent-1",
      plugins: [
        plugin({ id: "first", transform: () => ({ items: [] }) }),
        plugin({ id: "second", transform: second }),
      ],
    });

    expect(transformed).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it("rejects non-JSON data without breaking the timeline", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      agentId: "agent-1",
      plugins: [
        plugin({
          id: "broken",
          transform: () => ({
            items: [
              {
                type: "plugin" as const,
                kind: "bad-data",
                version: 1,
                data: { value: Number.NaN },
              },
            ],
          }),
        }),
      ],
    });

    expect(transformed).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("rejects class instances disguised as JSON data", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      agentId: "agent-1",
      plugins: [
        plugin({
          id: "broken",
          transform: () => ({
            items: [
              {
                type: "plugin" as const,
                kind: "bad-data",
                version: 1,
                data: { createdAt: new Date() } as never,
              },
            ],
          }),
        }),
      ],
    });

    expect(transformed).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("takes a JSON snapshot of transformed data", () => {
    const data = { passed: 4 };
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      agentId: "agent-1",
      plugins: [
        plugin({
          id: "reports",
          transform: () => ({
            items: [{ type: "plugin" as const, kind: "test-report", version: 1, data }],
          }),
        }),
      ],
    });

    data.passed = 0;
    expect(transformed?.[0]?.data).toEqual({ passed: 4 });
  });

  it("passes phase and preserves explicit output identity", () => {
    const transform = vi.fn(() => ({
      items: [
        {
          type: "plugin" as const,
          id: "summary",
          kind: "test-report",
          version: 1,
          data: { passed: 4 },
        },
      ],
    }));

    const transformed = transformTimelineItem({
      item: { ...toolCall, status: "running" },
      phase: "streaming",
      sourceId: "agent_tool_call-1",
      agentId: "agent-1",
      plugins: [plugin({ id: "reports", transform })],
    });

    expect(transform).toHaveBeenCalledWith({
      item: { ...toolCall, status: "running" },
      phase: "streaming",
    });
    expect(transformed?.[0]?.id).toBe("summary");
  });

  it("passes provider and agentId to source transformers", () => {
    const transform = vi.fn(() => ({ items: [] }));
    const sourcePlugin = plugin({ id: "reports", transform });
    sourcePlugin.timelineSourceTransformers = sourcePlugin.timelineTransformers;
    sourcePlugin.timelineTransformers = [];

    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "source",
      source: true,
      provider: "codex",
      agentId: "agent-1",
      plugins: [sourcePlugin],
    });

    expect(transform).toHaveBeenCalledWith({
      item: toolCall,
      phase: "complete",
      provider: "codex",
      agentId: "agent-1",
    });
    expect(transformed).toEqual([]);
  });
});

it("source transformers preserve first valid claim and fall back on errors or missing renderers", () => {
  const broken = plugin({
    id: "broken",
    transform: () => {
      throw new Error("broken");
    },
  });
  const missing = plugin({
    id: "missing",
    transform: () => ({
      items: [{ type: "plugin" as const, kind: "card", version: 1, data: { text: "x" } }],
    }),
  });
  const invalid = plugin({
    id: "invalid",
    transform: () => ({
      items: [{ type: "plugin" as const, kind: "card", version: 1, data: { text: 1 } }],
    }),
  });
  const hidden = plugin({ id: "hidden", transform: () => ({ items: [] }) });
  for (const candidate of [broken, missing, invalid, hidden]) {
    candidate.timelineSourceTransformers = candidate.timelineTransformers;
    candidate.timelineTransformers = [];
  }
  invalid.timelineRenderers = [
    { kind: "card", version: 1, schema: z.object({ text: z.string() }), Component: () => null },
  ];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(
      transformTimelineItem({
        item: toolCall,
        phase: "complete",
        sourceId: "source",
        source: true,
        provider: "codex",
        agentId: "agent-1",
        plugins: [broken, missing, invalid],
      }),
    ).toBeUndefined();
    expect(
      transformTimelineItem({
        item: toolCall,
        phase: "complete",
        sourceId: "source",
        source: true,
        provider: "codex",
        agentId: "agent-1",
        plugins: [broken, missing, invalid, hidden],
      }),
    ).toEqual([]);
    expect(toolCall.detail).toEqual({ type: "unknown", input: null, output: null });
  } finally {
    warn.mockRestore();
  }
});
