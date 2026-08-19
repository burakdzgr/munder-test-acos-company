// P1-A (UI/UX review): the active team filter resolved to a member-id set —
// shared by every Command Center panel that narrows to the chip's team.
// `set === null` means "no filter"; an EMPTY set is a real, valid state
// (0-member team → panels show their empty states, never a white screen).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, keys } from "./api.js";
import { useFocus, type TeamFilter } from "../stores/focus.js";

export function useTeamMemberSet(companyId: string): {
  team: TeamFilter | null;
  members: ReadonlySet<string> | null;
} {
  const team = useFocus((s) => s.teamFilter);
  const edges = useQuery({
    queryKey: keys.orgEdges(companyId),
    queryFn: () => api.org.listEdges(companyId),
    enabled: team !== null,
  });
  const members = useMemo(() => {
    if (!team) return null;
    return new Set(
      (edges.data ?? [])
        .filter((e) => e.kind === "member_of" && e.toUnitId === team.unitId && e.endedAt === null)
        .map((e) => e.fromAgentId),
    );
  }, [team, edges.data]);
  return { team, members };
}
