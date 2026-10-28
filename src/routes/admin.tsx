import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useCallback, useState } from "react";
import { useHostStatus } from "@/hooks/use-host-status";
import { MissionControlHeader } from "@/components/admin/MissionControlShell";
import { MissionControlShell } from "@/components/admin/MissionControlShell";
import { SectionKey, SECTIONS } from "@/components/admin/types";
import { OverviewSection } from "@/components/admin/OverviewSection";
import { UsersSection } from "@/components/admin/UsersSection";
import { LiveSessionsSection } from "@/components/admin/LiveSessionsSection";
import { AnalyticsSection } from "@/components/admin/AnalyticsSection";
import { CampaignListSection } from "@/components/admin/campaigns/CampaignListSection";
import { CampaignDetailSection } from "@/components/admin/campaigns/CampaignDetailSection";
import { PlaceholderSection } from "@/components/admin/PlaceholderSection";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

function AdminPage() {
  const { isAdmin, loading } = useHostStatus();
  const navigate = useNavigate();

  const [activeSection, setActiveSectionState] = useState<SectionKey>("overview");
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);

  // Redirect non-admin users before anything renders.
  useEffect(() => {
    if (!loading && !isAdmin) {
      navigate({ to: "/dashboard" });
    }
  }, [loading, isAdmin, navigate]);

  const onSectionChange = useCallback((key: SectionKey) => {
    setActiveSectionState(key);
    // When switching away from email section, clear selected campaign
    if (key !== "email") setSelectedCampaignId(null);
  }, []);

  const onCampaignSelect = useCallback((campaignId: string) => {
    setSelectedCampaignId(campaignId);
  }, []);

  const onBackToList = useCallback(() => {
    setSelectedCampaignId(null);
  }, []);

  if (loading || !isAdmin) return null;

  const sectionDef = SECTIONS[activeSection];

  return (
    <MissionControlShell
      activeSection={activeSection}
      onSectionChange={onSectionChange}
    >
      <MissionControlHeader
        activeSection={activeSection}
        onSectionChange={onSectionChange}
      />
      {renderSection(activeSection, selectedCampaignId, onCampaignSelect, onBackToList)}
    </MissionControlShell>
  );
}

function renderSection(
  key: SectionKey,
  selectedCampaignId: string | null,
  onCampaignSelect: (campaignId: string) => void,
  onBackToList: () => void,
) {
  // Campaign detail overrides the list when an ID is selected
  if (key === "email" && selectedCampaignId) {
    return (
      <CampaignDetailSection
        campaignId={selectedCampaignId}
        onBack={onBackToList}
      />
    );
  }

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
      return (
        <CampaignListSection onCampaignSelect={onCampaignSelect} />
      );
    case "ai":
    case "health":
    case "audit":
      return <PlaceholderSection key={key} />;
  }
}
