import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  createUserMessage,
  reduceStreamUpdate,
  type AgentToolCallData,
  type PluginTimelineStreamItem,
  type StreamItem,
} from "@/types/stream";
import type { TimelineItemTransform, TimelineSourceTransform } from "./model";

type AssistantPhase = "streaming" | "complete";

const projectionCache = new WeakMap<
  TimelineItemTransform,
  WeakMap<StreamItem, Partial<Record<AssistantPhase, StreamItem[]>>>
>();

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneAndFreeze(entry)])),
    ) as T;
  }
  return value;
}

function sourceToolCallTimelineItem(data: AgentToolCallData): ToolCallTimelineItem {
  const { callId, name, status, error, detail, metadata } = data;
  const base = {
    type: "tool_call" as const,
    callId,
    name,
    detail,
    ...(metadata ? { metadata } : {}),
  };
  switch (status) {
    case "running":
    case "completed":
    case "canceled":
      return { ...base, status, error: null };
    case "failed":
      return { ...base, status, error };
  }
}

function sourceTimelineItem(item: StreamItem): AgentTimelineItem | null {
  switch (item.kind) {
    case "user_message":
      return {
        type: "user_message",
        text: item.text,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
      };
    case "assistant_message":
      return {
        type: "assistant_message",
        text: item.text,
        ...(item.messageId ? { messageId: item.messageId } : {}),
      };
    case "thought":
      return { type: "reasoning", text: item.text };
    case "tool_call": {
      if (item.payload.source !== "agent") return null;
      return sourceToolCallTimelineItem(item.payload.data);
    }
    case "todo_list":
      return { type: "todo", items: item.items };
    case "notification":
      return item.sourceType === "error"
        ? { type: "error", message: item.message }
        : { type: "notification", level: item.level, message: item.message };
    case "compaction":
      return {
        type: "compaction",
        status: item.status,
        ...(item.trigger ? { trigger: item.trigger } : {}),
        ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}),
      };
    case "plugin":
      return null;
  }
}

function transformSourceItem(
  item: StreamItem,
  transformTimelineItem: TimelineItemTransform,
  assistantPhase: AssistantPhase,
): StreamItem[] {
  const source = sourceTimelineItem(item);
  if (!source) return [item];
  const isStreamingThought = item.kind === "thought" && item.status === "loading";
  const isStreamingToolCall =
    item.kind === "tool_call" &&
    item.payload.source === "agent" &&
    item.payload.data.status === "running";
  const isStreamingAssistant = item.kind === "assistant_message" && assistantPhase === "streaming";
  const phase =
    isStreamingAssistant || isStreamingThought || isStreamingToolCall ? "streaming" : "complete";
  const transformed = transformTimelineItem({
    item: cloneAndFreeze(source),
    phase,
    sourceId: item.id,
  });
  if (transformed === undefined) return [item];
  return transformed.map((pluginItem) => {
    const projected: PluginTimelineStreamItem = {
      kind: "plugin",
      id: `${pluginItem.pluginId}/${pluginItem.id}`,
      sourceId: item.id,
      timestamp: item.timestamp,
      pluginId: pluginItem.pluginId,
      pluginItemId: pluginItem.id,
      itemKind: pluginItem.kind,
      version: pluginItem.version,
      data: pluginItem.data,
    };
    if (item.timelineCursor) projected.timelineCursor = item.timelineCursor;
    if (item.turnId) projected.turnId = item.turnId;
    return projected;
  });
}

export function projectPluginTimelineItems(
  items: StreamItem[],
  transformTimelineItem: TimelineItemTransform | undefined,
  assistantPhase: AssistantPhase = "complete",
): StreamItem[] {
  if (!transformTimelineItem) return items;
  let bySource = projectionCache.get(transformTimelineItem);
  if (!bySource) {
    bySource = new WeakMap();
    projectionCache.set(transformTimelineItem, bySource);
  }
  let changed = false;
  const projected = items.flatMap((item) => {
    const cached = bySource.get(item)?.[assistantPhase];
    if (cached) {
      changed = changed || cached.length !== 1 || cached[0] !== item;
      return cached;
    }
    const output = transformSourceItem(item, transformTimelineItem, assistantPhase);
    bySource.set(item, { ...bySource.get(item), [assistantPhase]: output });
    changed = changed || output.length !== 1 || output[0] !== item;
    return output;
  });
  return changed ? projected : items;
}

interface SourceProjection {
  claimed: boolean;
  items: StreamItem[];
}
const sourceProjectionCache = new WeakMap<
  TimelineSourceTransform,
  WeakMap<StreamItem, Partial<Record<AssistantPhase, SourceProjection>>>
>();

function projectRetainedSourceItem(
  item: StreamItem,
  source: NonNullable<StreamItem["timelineSource"]>,
  transform: TimelineSourceTransform,
  assistantPhase: AssistantPhase,
): SourceProjection {
  const event = source.defaultItem && {
    type: "timeline" as const,
    provider: source.provider,
    item: source.defaultItem,
    turnId: item.turnId,
  };
  const raw = source.item;
  let phase: AssistantPhase = "complete";
  if (raw.type === "tool_call" && raw.status === "running") phase = "streaming";
  else if (raw.type === "assistant_message" || raw.type === "reasoning") phase = assistantPhase;
  const output = transform({
    item: cloneAndFreeze(raw),
    phase,
    sourceId: item.id,
    provider: source.provider,
  });
  if (output === undefined) {
    let native = event
      ? reduceStreamUpdate([], event, item.timestamp, {
          source: "canonical",
          timelineCursor: item.timelineCursor,
        }).map((projected) => {
          if (projected.kind === item.kind) projected.id = item.id;
          return projected;
        })
      : [];
    // Canonical acknowledgements deliberately retain local attachment metadata.
    // Rebuilding just from the provider text would discard those attachments,
    // including the entire row for an attachment-only submission.
    if (
      event?.item.type === "user_message" &&
      item.kind === "user_message" &&
      (item.images?.length || item.attachments?.length)
    ) {
      const user =
        native.find((entry) => entry.kind === "user_message") ??
        createUserMessage({ ...item, text: "" });
      native = [{ ...user, images: item.images, attachments: item.attachments }];
    }
    return { claimed: false, items: native };
  }
  return {
    claimed: true,
    items: output.map(
      (entry): PluginTimelineStreamItem => ({
        kind: "plugin",
        id: `${entry.pluginId}/${entry.id}`,
        sourceId: item.id,
        timestamp: item.timestamp,
        timelineCursor: item.timelineCursor,
        turnId: item.turnId,
        pluginId: entry.pluginId,
        pluginItemId: entry.id,
        itemKind: entry.kind,
        version: entry.version,
        data: entry.data,
      }),
    ),
  };
}

function shouldMergeNativeSourceProjection(
  previous: StreamItem | undefined,
  next: StreamItem | undefined,
): boolean {
  if (!next) return false;
  if (previous?.kind === "thought" && previous.status === "loading") return true;
  if (next.kind === "todo_list") return true;
  if (next.kind === "thought") return previous?.kind === "thought";
  return (
    next.kind === "assistant_message" &&
    previous?.kind === "assistant_message" &&
    (!next.messageId || next.messageId === previous.messageId)
  );
}

export function projectPluginTimelineSourceItems(
  items: StreamItem[],
  transform: TimelineSourceTransform,
  assistantPhase: AssistantPhase = "complete",
): StreamItem[] {
  let cache = sourceProjectionCache.get(transform);
  if (!cache) {
    cache = new WeakMap();
    sourceProjectionCache.set(transform, cache);
  }
  let projected: StreamItem[] = [];
  for (const item of items) {
    const source = item.timelineSource;
    if (!source) {
      projected.push(item);
      continue;
    }
    let resolved = cache.get(item)?.[assistantPhase];
    const event = source.defaultItem && {
      type: "timeline" as const,
      provider: source.provider,
      item: source.defaultItem,
      turnId: item.turnId,
    };
    if (!resolved) {
      resolved = projectRetainedSourceItem(item, source, transform, assistantPhase);
      cache.set(item, { ...cache.get(item), [assistantPhase]: resolved });
    }
    const previous = projected.at(-1);
    const next = resolved.items[0];
    const mergeNative = !resolved.claimed && shouldMergeNativeSourceProjection(previous, next);
    if (mergeNative && event) {
      projected = reduceStreamUpdate(projected, event, item.timestamp, {
        source: "canonical",
        timelineCursor: item.timelineCursor,
      });
    } else {
      projected.push(...resolved.items);
    }
  }
  return projected;
}
