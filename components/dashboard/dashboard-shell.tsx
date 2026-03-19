"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Header } from "./header";

const PATH_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/markets": "Markets",
  "/portfolio": "Portfolio",
  "/portfolio/timeline": "Portfolio timeline",
  "/recommendations": "Recommendations",
  "/bot": "Bot Command Center",
  "/orders": "Orders",
  "/ops": "Ops",
  "/paper-trading": "Paper trading",
  "/analytics": "Analytics",
  "/ml": "ML baseline",
  "/settings/polymarket": "Polymarket settings",
};

function getTitleForPath(pathname: string): string {
  if (PATH_TITLES[pathname]) return PATH_TITLES[pathname];
  if (pathname.startsWith("/markets/")) return "Market detail";
  if (pathname.startsWith("/recommendations/")) return "Recommendation detail";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Dashboard";
}

interface DashboardShellProps {
  children: React.ReactNode;
  title?: string;
  headerChildren?: React.ReactNode;
}

export function DashboardShell({
  children,
  title: titleProp,
  headerChildren,
}: DashboardShellProps) {
  const pathname = usePathname();
  const title = titleProp ?? getTitleForPath(pathname ?? "/");

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <div className="lg:pl-64">
        <Header title={title}>{headerChildren}</Header>
        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
