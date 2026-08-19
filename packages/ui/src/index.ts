export const packageName = "@acos/ui" as const;

export { acosPreset } from "./preset.js";
export {
  acosDarkSurfaces,
  acosDarkText,
  acosDarkCss,
  presenceColors,
  presenceColor,
  type PresenceStatus,
} from "./theme/acosDark.js";
export {
  departmentColors,
  departmentColor,
  type Department,
} from "./theme/departmentColors.js";
export {
  cn,
  Button,
  Card,
  Input,
  Textarea,
  Select,
  Field,
  Dialog,
  DataTable,
  StatusPill,
  type DataTableColumn,
  type PillTone,
} from "./primitives.js";
export {
  AgentAvatar,
  AgentStatusPill,
  RiskBadge,
  MoneyText,
  EventRow,
} from "./widgets.js";
export {
  CommandIcon,
  DashboardIcon,
  OfficeIcon,
  TasksIcon,
  AgentsIcon,
  ProjectsIcon,
  MemoryIcon,
  OrganizationIcon,
  SkillsIcon,
  CommunicationIcon,
  TerminalsIcon,
  ApprovalsIcon,
  EventsIcon,
  ReportsIcon,
  CostsIcon,
  SettingsIcon,
  SearchIcon,
  BellIcon,
  PlusIcon,
  CloseIcon,
  ChevronDownIcon,
  type IconProps,
} from "./icons.js";
