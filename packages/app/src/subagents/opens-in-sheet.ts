import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { SubagentRow } from "./select";

/** The workspace target a subagent row opens. */
export function subagentRowTarget(row: SubagentRow): WorkspaceTabTarget {
  return row.kind === "provider"
    ? { kind: "provider_subagent", parentAgentId: row.parentAgentId, subagentId: row.id }
    : { kind: "agent", agentId: row.id };
}

/** Answers, per subagent row, whether opening it in this workspace shows a sheet rather than a tab. */
export function useSubagentOpensInSheet(
  workspaceKey: string | null,
): (row: SubagentRow) => boolean {
  // Sheet placement follows the layout mode; subscribing re-renders the rows when it changes.
  useWorkspaceLayoutStore((state) => state.layoutMode);
  return (row) =>
    workspaceKey !== null &&
    useWorkspaceLayoutStore
      .getState()
      .opensInSheet({ workspaceKey, target: subagentRowTarget(row), intent: "reveal" });
}
