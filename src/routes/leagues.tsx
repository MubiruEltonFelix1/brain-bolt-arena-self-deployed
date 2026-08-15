import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/leagues")({
  component: LeaguesLayout,
});

function LeaguesLayout() {
  return <Outlet />;
}