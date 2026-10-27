import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useCallback, useState } from "react";
import { HostShell } from "@/components/host-shell";
import { useHostStatus } from "@/hooks/use-host-status";
import { MissionControlHeader } from "@/components/admin/MissionControlShell";
import { MissionControlShell } from "@/components/admin/MissionControlShell";
import { SectionKey, SECTIONS } from "@/components/admin/types";
import { OverviewSection } from "@/components/admin/OverviewSection";
import { UsersSection } from "@/components/admin/UsersSection";
import { LiveSessionsSection } from "@/components/admin/LiveSessionsSection";
import { AnalyticsSection } from "@/components/admin/AnalyticsSection";
import { PlaceholderSection } from "@/components/admin/PlaceholderSection";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

function AdminPage() {
  const { isAdmin, loading } = useHostStatus();
  const navigate = useNavigate();

  const [activeSection, setActiveSectionState] = useState<SectionKey>("overview");

  // Redirect non-admin users before anything renders.
  useEffect(() => {
    if (!loading && !isAdmin) {
      navigate({ to: "/dashboard" });
    }
  }, [loading, isAdmin, navigate]);

  const onSectionChange = useCallback((key: SectionKey) => {
    setActiveSectionState(key);
  }, []);

  if (loading || !isAdmin) return null;

  const sectionDef = SECTIONS[activeSection];

  return (
    <HostShell title="Admin">
      <MissionControlHeader activeSection={activeSection} onSectionChange={onSectionChange} />
      <MissionControlShell activeSection={activeSection} onSectionChange={onSectionChange}>
        {renderSection(activeSection)}
      </MissionControlShell>
    </HostShell>
  );
}

function renderSection(key: SectionKey) {
  switch (key) {
    case "overview":
      return <OverviewSection />;
    case "users":
      return <UsersSection />;
    case "live":
      return <LiveSessionsSection />;
    case "analytics":
      return <AnalyticsSection />;
    case "email":
    case "ai":
    case "health":
    case "audit":
      return <PlaceholderSection key={key} />;
  }
}
