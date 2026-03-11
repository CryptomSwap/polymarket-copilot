import { PolymarketSyncWidgets } from "@/components/dashboard/polymarket-sync-widgets";
import { PortfolioOverviewWidget } from "@/components/dashboard/portfolio-overview-widget";
import { PortfolioIntelligenceWidget } from "@/components/dashboard/portfolio-intelligence-widget";
import { RecommendationsWidget } from "@/components/dashboard/recommendations-widget";
import { NewsSyncWidget } from "@/components/dashboard/news-sync-widget";
import { AlertsWidget } from "@/components/dashboard/alerts-widget";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Dashboard
        </h2>
        <p className="text-muted-foreground">
          Overview of your Polymarket activity and linked account.
        </p>
      </div>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">
          Alerts
        </h3>
        <AlertsWidget />
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">
          Top recommendations
        </h3>
        <RecommendationsWidget />
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">
          Portfolio overview
        </h3>
        <PortfolioOverviewWidget />
      </section>

      <section aria-label="Portfolio Intelligence">
        <h3 className="mb-3 text-lg font-semibold text-foreground">
          Portfolio Intelligence
        </h3>
        <PortfolioIntelligenceWidget />
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">
          News ingestion
        </h3>
        <NewsSyncWidget />
      </section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-foreground">
          Polymarket sync (read-only)
        </h3>
        <PolymarketSyncWidgets />
      </section>
    </div>
  );
}
