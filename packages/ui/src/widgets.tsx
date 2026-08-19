// Domain widgets (28 §2): AgentAvatar, RiskBadge, MoneyText, EventRow.
// No data fetching — pure presentational.
import { StatusPill, cn, type PillTone } from "./primitives.js";

// deterministic accenting per name
const AVATAR_HUES = [212, 262, 152, 22, 332, 190, 82, 292];

export function AgentAvatar({
  name,
  size = 36,
  imageUrl,
}: {
  name: string;
  size?: number;
  imageUrl?: string | null;
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        width={size}
        height={size}
        className="rounded-full object-cover"
      />
    );
  }
  const initials = name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const hue = AVATAR_HUES[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_HUES.length];
  return (
    <span
      aria-label={name}
      className="inline-flex select-none items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `hsl(${hue} 55% 48%)`,
      }}
    >
      {initials}
    </span>
  );
}

const AGENT_STATUS_TONE: Record<string, PillTone> = {
  draft: "neutral",
  active: "ok",
  paused: "warn",
  offboarded: "danger",
};

export function AgentStatusPill({ status }: { status: string }) {
  return <StatusPill tone={AGENT_STATUS_TONE[status] ?? "neutral"}>{status}</StatusPill>;
}

const RISK_TONE: Record<string, PillTone> = {
  low: "ok",
  medium: "warn",
  high: "danger",
  critical: "danger",
  R0: "ok",
  R1: "accent",
  R2: "warn",
  R3: "danger",
};

export function RiskBadge({ risk }: { risk: string }) {
  return <StatusPill tone={RISK_TONE[risk] ?? "neutral"}>{risk}</StatusPill>;
}

/** Integer minor units + company currency (A4). */
export function MoneyText({
  cents,
  currency,
  className,
}: {
  cents: number;
  currency: string;
  className?: string;
}) {
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
  return <span className={cn("tabular-nums", className)}>{formatted}</span>;
}

export function EventRow({
  type,
  occurredAt,
  summary,
}: {
  type: string;
  occurredAt: string;
  summary?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 border-b border-acos-line/60 py-1.5 text-sm last:border-0">
      <time className="shrink-0 tabular-nums text-xs text-acos-fg2">
        {new Date(occurredAt).toLocaleTimeString()}
      </time>
      <code className="shrink-0 rounded bg-acos-bg2 px-1.5 py-0.5 text-xs text-accent-600">{type}</code>
      {summary && <span className="truncate text-acos-fg1">{summary}</span>}
    </div>
  );
}
