"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BarChart3,
  Lightbulb,
  TrendingUp,
  Wallet,
  Settings,
  Menu,
  ShoppingCart,
  Cpu,
  Activity,
  Bot,
  LineChart,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTrigger, useSheet } from "@/components/ui/sheet";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/markets", label: "Markets", icon: TrendingUp },
  { href: "/portfolio", label: "Portfolio", icon: Wallet },
  { href: "/recommendations", label: "Recommendations", icon: Lightbulb },
  { href: "/bot", label: "Bot", icon: Bot },
  { href: "/orders", label: "Orders", icon: ShoppingCart },
  { href: "/ops", label: "Ops", icon: Activity },
  { href: "/paper-trading", label: "Paper trading", icon: LineChart },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/ml", label: "ML baseline", icon: Cpu },
  { href: "/settings/polymarket", label: "Polymarket", icon: Settings },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {navItems.map(({ href, label, icon: Icon }) => {
        const isActive =
          pathname === href || (href !== "/" && pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <Icon className="h-5 w-5 shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function MobileNavContent() {
  const { onOpenChange } = useSheet();
  return <NavLinks onNavigate={() => onOpenChange(false)} />;
}

export function Sidebar() {
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-16 items-center gap-2 border-b border-border px-6">
          <span className="font-semibold tracking-tight text-foreground">
            Polymarket Copilot
          </span>
        </div>
        <div className="flex-1 space-y-4 overflow-auto p-4">
          <NavLinks />
        </div>
        <Separator />
        <div className="p-4">
          <p className="text-xs text-muted-foreground">
            Account-linked dashboard
          </p>
        </div>
      </aside>

      {/* Mobile: menu button + sheet */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-3 lg:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <div className="flex h-16 items-center border-b border-border px-6">
              <span className="font-semibold tracking-tight">
                Polymarket Copilot
              </span>
            </div>
            <div className="p-4">
              <MobileNavContent />
            </div>
          </SheetContent>
        </Sheet>
        <span className="font-semibold tracking-tight text-foreground">
          Polymarket Copilot
        </span>
      </div>
    </>
  );
}
