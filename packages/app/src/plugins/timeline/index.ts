import { useMemo } from "react";
import { useInstalledPlugins } from "../registry";
import {
  transformTimelineItem,
  type TimelineItemTransform,
  type TimelineItemTransformInput,
  type TimelineSourceTransform,
  type TimelineSourceTransformInput,
} from "./model";

export type {
  InstalledPluginTimelineItem,
  TimelineItemTransform,
  TimelineSourceTransform,
} from "./model";
export { PluginTimelineItemView } from "./view";

export function useInstalledTimelineTransform(
  serverId: string,
  agentId: string,
  source: true,
): TimelineSourceTransform;
export function useInstalledTimelineTransform(
  serverId: string,
  agentId: string,
): TimelineItemTransform;
export function useInstalledTimelineTransform(
  serverId: string,
  agentId: string,
  source = false,
): TimelineItemTransform | TimelineSourceTransform {
  const installed = useInstalledPlugins();
  const plugins = useMemo(
    () => installed.filter((plugin) => plugin.serverId === serverId),
    [installed, serverId],
  );
  return useMemo(
    () =>
      source
        ? (input: TimelineSourceTransformInput) =>
            transformTimelineItem({ ...input, plugins, agentId, source: true })
        : (input: TimelineItemTransformInput) =>
            transformTimelineItem({ ...input, plugins, agentId }),
    [plugins, agentId, source],
  );
}
