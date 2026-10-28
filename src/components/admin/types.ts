import type { ComponentType } from "react";
import {
  LayoutDashboard,
  Users,
  Monitor,
  BarChart3,
  Mail,
  Brain,
  Cpu,
  FileText,
} from "lucide-react";

/**
 * Every admin section in Mission Control. Keys are stable and double as the
 * URL search param (`?section=users`) so sections are shareable and survive
 * refreshes. Implemented sections render real data; future sections render a
 * clearly marked "coming soon" placeholder.
 */
export type SectionKey =
  | "overview"
  | "users"
  | "live"
  | "analytics"
  | "email"
  | "ai"
  | "health"
  | "audit";

export interface SectionDef {
  key: SectionKey;
  label: string;
  description: string;
  group: "platform" | "operations";
  /** Whether the section renders real data or a coming-soon placeholder. */
  implemented: boolean;
  icon: ComponentType<{ className?: string }>;
}

export const SECTIONS: Record<SectionKey, SectionDef> = {
  overview: {
    key: "overview",
    label: "Overview",
    description: "Platform operations at a glance.",
    group: "platform",
    implemented: true,
    icon: LayoutDashboard,
  },
  users: {
    key: "users",
    label: "Users",
    description: "User and host authorization management.",
    group: "platform",
    implemented: true,
    icon: Users,
  },
  live: {
    key: "live",
    label: "Live Sessions",
    description: "Monitor and manage live game sessions.",
    group: "platform",
    implemented: true,
    icon: Monitor,
  },
  analytics: {
    key: "analytics",
    label: "Analytics",
    description: "Platform usage and performance trends.",
    group: "platform",
    implemented: true,
    icon: BarChart3,
  },
  email: {
    key: "email",
    label: "Email & Communications",
    description: "Campaigns and announcements.",
    group: "operations",
    implemented: true,
    icon: Mail,
  },
  ai: {
    key: "ai",
    label: "AI Usage & Controls",
    description: "Model usage, cost limits, kill switch.",
    group: "operations",
    implemented: true,
    icon: Brain,
  },
  health: {
    key: "health",
    label: "System Health",
    description: "Scheduler, background jobs, diagnostics.",
    group: "operations",
    implemented: true,
    icon: Cpu,
  },
  audit: {
    key: "audit",
    label: "Audit Log",
    description: "Privileged administrative action trail.",
    group: "operations",
    implemented: false,
    icon: FileText,
  },
} as const;

export const PLATFORM_SECTIONS: SectionKey[] = ["overview", "users", "live", "analytics"];

export const OPERATIONS_SECTIONS: SectionKey[] = ["email", "ai", "health", "audit"];

export function sectionByKey(key: string): SectionDef | undefined {
  return SECTIONS[key as SectionKey];
}
