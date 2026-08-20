// Line-style inline SVG icon set (36 §2 UI overhaul) — hand-written, no
// external icon package (pnpm install is unreliable in this environment).
// Stroke-based, 18-20px, lucide-esque geometry. Each icon accepts standard
// SVG props so callers can set className/size/color via currentColor.
import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(props: IconProps) {
  const { size = 18, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

export function CommandIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function DashboardIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 13h4v8H3z" />
      <path d="M10 8h4v13h-4z" />
      <path d="M17 4h4v17h-4z" />
    </svg>
  );
}

export function OfficeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 21V7l8-4 8 4v14" />
      <path d="M9 21v-6h6v6" />
      <path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01" />
    </svg>
  );
}

export function TasksIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="m7.5 12 2.4 2.4L16.5 8" />
    </svg>
  );
}

export function AgentsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6" />
      <circle cx="17.5" cy="8.5" r="2.2" />
      <path d="M15.5 14.2c2.6.4 4.5 2.6 4.5 5.3" />
    </svg>
  );
}

export function ProjectsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5H9l2 2.2h8.5A1.5 1.5 0 0 1 21 9.7V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" />
    </svg>
  );
}

export function MemoryIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 3.5a3.5 3.5 0 0 0-3.4 4.3A3.5 3.5 0 0 0 5 14.4V17a3.5 3.5 0 0 0 3.5 3.5" />
      <path d="M15 3.5a3.5 3.5 0 0 1 3.4 4.3A3.5 3.5 0 0 1 19 14.4V17a3.5 3.5 0 0 1-3.5 3.5" />
      <path d="M9 3.5h6M9 20.5h6M7 9h3M14 9h3M7.5 13.5h9" />
    </svg>
  );
}

export function OrganizationIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="4.5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 6.5v5m0 0-7 5m7-5 7 5" />
    </svg>
  );
}

export function SkillsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M6 11v5c0 1.6 2.7 3 6 3s6-1.4 6-3v-5" />
    </svg>
  );
}

export function CommunicationIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5.5h16v10H9.5L5 19v-3.5H4z" />
    </svg>
  );
}

export function TerminalsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

export function ApprovalsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 12.5 11.2 15 16 9" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function EventsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M13 3 5 13.5h5.5L11 21l8-10.5h-5.5z" />
    </svg>
  );
}

export function ReportsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
      <path d="M14 3.5V8h4M8.5 12.5h7M8.5 15.5h7M8.5 18h4" />
    </svg>
  );
}

export function CostsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.5v11M15 9.2c0-1.2-1.3-2.2-3-2.2s-3 .9-3 2.1c0 3 6 1.5 6 4.5 0 1.2-1.3 2.1-3 2.1s-3-1-3-2.2" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9c.8.6 1.7 1.1 2.6 1.5l.5 2.5h4l.5-2.5c.9-.4 1.8-.9 2.6-1.5l2.3.9 2-3.4Z" />
    </svg>
  );
}

// E1: üst çubuktaki Founder kimliği — tıklanınca CEO'ya görev verme
// diyaloğu açılır, yani bu ikon "ben" değil "işi buradan veriyorum" demek.
export function UserIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M4.5 20c0-3.6 3.4-6.2 7.5-6.2s7.5 2.6 7.5 6.2" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10Z" />
      <path d="M9.5 18.5a2.5 2.5 0 0 0 5 0" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
