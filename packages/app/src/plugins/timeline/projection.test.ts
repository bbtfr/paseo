import { describe, expect, it, vi } from "vitest";
import { reduceStreamUpdate, type StreamItem } from "@/types/stream";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { TimelineItemTransform } from "./model";
import { projectPluginTimelineItems, projectPluginTimelineSourceItems } from "./projection";

function thought(text: string, status: "loading" | "ready" = "loading"): StreamItem {
  return {
    kind: "thought",
    id: "thought-1",
    text,
    status,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("plugin timeline projection", () => {
  it("does not expose mutable tool detail from stream state", () => {
    const detail = { type: "read" as const, filePath: "/repo/original.ts" };
    const source: StreamItem = {
      kind: "tool_call",
      id: "tool-1",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "call-1",
          name: "Read",
          status: "completed",
          error: null,
          detail,
        },
      },
    };
    const mutateDetail: TimelineItemTransform = ({ item }) => {
      if (item.type === "tool_call" && item.detail.type === "read") {
        item.detail.filePath = "/repo/mutated.ts";
      }
      return undefined;
    };

    expect(() => projectPluginTimelineItems([source], mutateDetail)).toThrow(TypeError);
    expect(detail.filePath).toBe("/repo/original.ts");
  });

  it("projects a streaming reasoning row from its first delta", () => {
    const transform: TimelineItemTransform = vi.fn(({ item, phase, sourceId }) => [
      {
        type: "plugin" as const,
        id: `${sourceId}/0`,
        pluginId: "inline-thinking",
        kind: "reasoning",
        version: 1,
        data: { text: item.type === "reasoning" ? item.text : "", phase },
      },
    ]);

    expect(projectPluginTimelineItems([thought("First")], transform)).toMatchObject([
      {
        kind: "plugin",
        id: "inline-thinking/thought-1/0",
        data: { text: "First", phase: "streaming" },
      },
    ]);
  });

  it("memoizes projection on the source row reference", () => {
    const source = thought("Stable");
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    projectPluginTimelineItems([source], transform);
    projectPluginTimelineItems([source], transform);

    expect(transform).toHaveBeenCalledOnce();
  });

  it("preserves whether a notification row came from an agent error or a notice", () => {
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    const timestamp = new Date("2026-01-01T00:00:00.000Z");

    projectPluginTimelineItems(
      [
        {
          kind: "notification",
          sourceType: "error",
          id: "error-1",
          level: "error",
          message: "Agent failed",
          timestamp,
        },
        {
          kind: "notification",
          sourceType: "notification",
          id: "notice-1",
          level: "error",
          message: "Extension reported an error",
          timestamp,
        },
      ],
      transform,
    );

    expect(transform).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ item: { type: "error", message: "Agent failed" } }),
    );
    expect(transform).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        item: {
          type: "notification",
          level: "error",
          message: "Extension reported an error",
        },
      }),
    );
  });

  it("reprojects when streaming produces a new source row", () => {
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    projectPluginTimelineItems([thought("First")], transform);
    projectPluginTimelineItems([thought("First second")], transform);

    expect(transform).toHaveBeenCalledTimes(2);
  });

  it("filters and explodes source rows", () => {
    const source = thought("Split", "ready");
    const exploded = projectPluginTimelineItems([source], ({ sourceId }) => [
      {
        type: "plugin",
        id: `${sourceId}/left`,
        pluginId: "split",
        kind: "part",
        version: 1,
        data: { side: "left" },
      },
      {
        type: "plugin",
        id: `${sourceId}/right`,
        pluginId: "split",
        kind: "part",
        version: 1,
        data: { side: "right" },
      },
    ]);
    const filtered = projectPluginTimelineItems([source], () => []);

    expect(exploded.map((item) => item.id)).toEqual([
      "split/thought-1/left",
      "split/thought-1/right",
    ]);
    expect(filtered).toEqual([]);
  });
});

describe("plugin timeline source projection", () => {
  const timestamp = new Date("2026-01-01T00:00:00Z");
  const pass: TimelineItemTransform = () => undefined;
  function ingest(
    item: AgentTimelineItem,
    defaultItem: AgentTimelineItem | null = item,
    state: StreamItem[] = [],
    provider = "claude",
  ) {
    return reduceStreamUpdate(
      state,
      { type: "timeline", provider, item, source: { defaultItem } },
      timestamp,
      { timelineCursor: { epoch: "epoch", seq: state.length + 1 } },
    );
  }

  it("exposes a hidden system input, falls back to hiding, and reprojects on hot reload", () => {
    const raw: AgentTimelineItem = {
      type: "user_message",
      messageId: "scheduled",
      text: "<paseo-system>check status</paseo-system>",
    };
    const state = ingest(raw, null);
    expect(projectPluginTimelineSourceItems(state, pass)).toEqual([]);
    const take: TimelineItemTransform = vi.fn(({ item, sourceId }) => [
      {
        type: "plugin" as const,
        id: sourceId,
        pluginId: "system-messages",
        kind: "message",
        version: 1,
        data: { text: item.type === "user_message" ? item.text : "" },
      },
    ]);
    expect(projectPluginTimelineSourceItems(state, take)).toMatchObject([
      { kind: "plugin", data: { text: raw.text }, timelineCursor: { epoch: "epoch", seq: 1 } },
    ]);
    expect(take).toHaveBeenCalledWith(
      expect.objectContaining({ item: raw, phase: "complete", provider: "claude" }),
    );
    expect(projectPluginTimelineSourceItems(state, pass)).toEqual([]);
    expect(state[0]?.timelineSource?.item).toEqual(raw);
  });

  it.each(["Prompt with image", ""])(
    "preserves local attachments in native source fallback: %j",
    (text) => {
      const raw: AgentTimelineItem = {
        type: "user_message",
        text: "provider envelope",
        clientMessageId: "submission",
      };
      const image = {
        id: "image",
        mimeType: "image/png",
        storageType: "web-indexeddb" as const,
        storageKey: "image",
        createdAt: 1,
      };
      const row: StreamItem = {
        kind: "user_message",
        id: "submission",
        clientMessageId: "submission",
        text,
        timestamp,
        images: [image],
        timelineSource: { item: raw, defaultItem: { ...raw, text }, provider: "mock" },
      };
      expect(projectPluginTimelineSourceItems([row], pass)).toMatchObject([
        { kind: "user_message", id: "submission", text, images: [image] },
      ]);
      expect(
        projectPluginTimelineSourceItems(
          [{ ...row, timelineSource: { ...row.timelineSource!, defaultItem: null } }],
          pass,
        ),
      ).toEqual([]);
      expect(projectPluginTimelineSourceItems([row], () => [])).toEqual([]);
    },
  );

  it("runs source tool transformers before native Todo conversion or hiding", () => {
    const raw: AgentTimelineItem = {
      type: "tool_call",
      name: "TaskUpdate",
      callId: "task",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: { taskId: "1", status: "completed" }, output: null },
    };
    const state = ingest(raw);
    const inspect: TimelineItemTransform = vi.fn(() => undefined);
    expect(projectPluginTimelineSourceItems(state, inspect)).toEqual([]);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ item: raw }));
    expect(projectPluginTimelineSourceItems(state, () => [])).toEqual([]);
  });

  it("keeps a growing source message and its native fallback complete", () => {
    const first: AgentTimelineItem = {
      type: "assistant_message",
      messageId: "reply",
      text: "Hello ",
    };
    const second: AgentTimelineItem = { ...first, text: "world" };
    const live = ingest(second, second, ingest(first));
    const replay = ingest({ ...first, text: "Hello world" });
    const inspect: TimelineItemTransform = vi.fn(() => undefined);
    expect(projectPluginTimelineSourceItems(live, inspect, "streaming")).toMatchObject([
      { kind: "assistant_message", text: "Hello world" },
    ]);
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ item: { ...first, text: "Hello world" }, phase: "streaming" }),
    );
    expect(projectPluginTimelineSourceItems(replay, pass)).toMatchObject([
      { kind: "assistant_message", text: "Hello world" },
    ]);
  });

  it("preserves full source text while applying the native limited fallback", () => {
    const raw: AgentTimelineItem = {
      type: "user_message",
      messageId: "long",
      text: "original full message",
    };
    const state = ingest(raw, { ...raw, text: "original…" });
    const inspect: TimelineItemTransform = vi.fn(() => undefined);
    expect(projectPluginTimelineSourceItems(state, inspect)).toMatchObject([{ text: "original…" }]);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ item: raw }));
  });
});

it("retains native row references and skips old source transforms when history grows", () => {
  const timestamp = new Date("2026-01-01T00:00:00Z");
  const rows: StreamItem[] = Array.from({ length: 1000 }, (_, index) => {
    const raw = {
      type: "assistant_message" as const,
      messageId: `message-${index}`,
      text: `Reply ${index}`,
    };
    return {
      kind: "assistant_message",
      id: raw.messageId,
      messageId: raw.messageId,
      text: raw.text,
      timestamp,
      timelineSource: { item: raw, defaultItem: raw, provider: "mock" },
    };
  });
  const transform = vi.fn<TimelineItemTransform>(() => undefined);
  const start = performance.now();
  const initial = projectPluginTimelineSourceItems(rows, transform);
  const coldMs = performance.now() - start;
  transform.mockClear();
  const raw = { type: "assistant_message" as const, messageId: "new", text: "Latest" };
  const next: StreamItem = {
    kind: "assistant_message",
    id: "new",
    messageId: "new",
    text: raw.text,
    timestamp,
    timelineSource: { item: raw, defaultItem: raw, provider: "mock" },
  };
  const warmStart = performance.now();
  const updated = projectPluginTimelineSourceItems([...rows, next], transform);
  const warmMs = performance.now() - warmStart;
  expect(transform).toHaveBeenCalledTimes(1);
  expect(updated.slice(0, 1000).every((item, index) => item === initial[index])).toBe(true);
  console.info(
    `Source timeline: 1000 rows cold=${coldMs.toFixed(2)}ms, append=${warmMs.toFixed(2)}ms`,
  );
});

it("source fallback matches native reasoning completion and message identity", () => {
  const timestamp = new Date("2026-01-01T00:00:00Z");
  const events: AgentTimelineItem[] = [
    { type: "user_message", text: "Question", messageId: "u1" },
    { type: "reasoning", text: "Thinking" },
    { type: "assistant_message", text: "Reply", messageId: "a1" },
    {
      type: "tool_call",
      name: "Shell",
      callId: "shell1",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "true", output: "" },
    },
  ];
  let native: StreamItem[] = [];
  let source: StreamItem[] = [];
  for (const [index, item] of events.entries()) {
    const event = { type: "timeline" as const, provider: "mock", item };
    const options = {
      source: "canonical" as const,
      timelineCursor: { epoch: "epoch", seq: index + 1 },
    };
    native = reduceStreamUpdate(native, event, timestamp, options);
    source = reduceStreamUpdate(
      source,
      { ...event, source: { defaultItem: item } },
      timestamp,
      options,
    );
  }
  expect(projectPluginTimelineSourceItems(source, () => undefined)).toEqual(native);
});
