// Hire wizard (24 §6.6 edit mode): position, unit, manager, seniority,
// autonomy, persona → POST /agents (04 §6.1 single transaction server-side).
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Dialog, Field, Input, Select, Textarea } from "@acos/ui";
import { AcosApiError } from "@acos/contracts/client";
import { api, keys, queryClient } from "../../lib/api.js";

const SENIORITIES = ["junior", "mid", "senior", "staff", "lead", "expert"] as const;

export function HireWizard({
  companyId,
  open,
  onClose,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const units = useQuery({
    queryKey: keys.orgUnits(companyId),
    queryFn: () => api.org.listUnits(companyId),
    enabled: open,
  });
  const positions = useQuery({
    queryKey: keys.orgPositions(companyId),
    queryFn: () => api.org.listPositions(companyId),
    enabled: open,
  });
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
    enabled: open,
  });

  const [name, setName] = useState("");
  const [positionId, setPositionId] = useState("");
  const [orgUnitId, setOrgUnitId] = useState("");
  const [managerAgentId, setManagerAgentId] = useState("");
  const [seniority, setSeniority] = useState<(typeof SENIORITIES)[number]>("mid");
  const [autonomyLevel, setAutonomyLevel] = useState(2);
  const [persona, setPersona] = useState("");
  const [error, setError] = useState<string | null>(null);

  const hire = useMutation({
    mutationFn: () =>
      api.agents.hire(companyId, {
        name,
        positionId,
        orgUnitId,
        seniority,
        autonomyLevel,
        persona,
        managerAgentId: managerAgentId === "" ? null : managerAgentId,
        activate: true,
      }),
    onSuccess: async () => {
      setName("");
      setPersona("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: keys.agents(companyId) });
      await queryClient.invalidateQueries({ queryKey: keys.orgEdges(companyId) });
      onClose();
    },
    onError: (err) =>
      setError(err instanceof AcosApiError ? (err.problem.detail ?? err.problem.code) : String(err)),
  });

  return (
    <Dialog open={open} title="Ajan işe al" onClose={onClose}>
      <form
        className="space-y-3"
        data-testid="hire-wizard"
        onSubmit={(e) => {
          e.preventDefault();
          hire.mutate();
        }}
      >
        <Field label="İsim">
          <Input name="agentName" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pozisyon">
            <Select
              name="agentPosition"
              value={positionId}
              onChange={(e) => setPositionId(e.target.value)}
              required
            >
              <option value="">— seçin —</option>
              {positions.data?.map((position) => (
                <option key={position.id} value={position.id}>
                  {position.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Birim">
            <Select
              name="agentUnit"
              value={orgUnitId}
              onChange={(e) => setOrgUnitId(e.target.value)}
              required
            >
              <option value="">— seçin —</option>
              {units.data?.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Yönetici">
            <Select
              name="agentManager"
              value={managerAgentId}
              onChange={(e) => setManagerAgentId(e.target.value)}
            >
              <option value="">— üst seviye —</option>
              {agents.data
                ?.filter((agent) => agent.status === "active")
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Kıdem">
            <Select value={seniority} onChange={(e) => setSeniority(e.target.value as never)}>
              {SENIORITIES.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={`Otonomi seviyesi (L${autonomyLevel})`}>
          <input
            type="range"
            min={0}
            max={5}
            value={autonomyLevel}
            onChange={(e) => setAutonomyLevel(Number(e.target.value))}
            className="w-full"
          />
        </Field>
        <Field label="Persona (kısa profesyonel özgeçmiş)">
          <Textarea
            name="agentPersona"
            rows={3}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            required
          />
        </Field>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={hire.isPending} className="w-full justify-center">
          {hire.isPending ? "İşe alınıyor…" : "İşe al & aktifleştir"}
        </Button>
      </form>
    </Dialog>
  );
}
