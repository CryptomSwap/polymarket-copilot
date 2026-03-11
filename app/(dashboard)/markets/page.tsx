"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface MarketRow {
  id: string;
  slug: string | null;
  title: string;
  status: string;
  category: string | null;
  endDate: string | null;
}

export default function MarketsPage() {
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchMarkets = useCallback(async () => {
    try {
      const res = await fetch("/api/markets?limit=200");
      if (res.ok) {
        const data = await res.json();
        setMarkets(data.markets ?? []);
      } else setMarkets([]);
    } catch {
      setMarkets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Markets
        </h2>
        <p className="text-muted-foreground">
          Browse synced prediction markets. Click a row to open market detail.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Market list</CardTitle>
          <CardDescription>
            Synced from Polymarket. Link to detail page for prices, signals, positions, notes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : markets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No markets synced yet. Run &quot;Sync markets&quot; on the dashboard.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Market</th>
                    <th className="text-left py-2 px-2 font-medium">Status</th>
                    <th className="text-left py-2 px-2 font-medium">Category</th>
                    <th className="text-left py-2 px-2 font-medium">End date</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((m) => (
                    <tr key={m.id} className="border-b border-border/50 hover:bg-muted/50">
                      <td className="py-2 px-2 max-w-[320px]">
                        {m.slug ? (
                          <Link href={`/markets/${encodeURIComponent(m.slug)}`} className="hover:underline truncate block font-medium">
                            {m.title}
                          </Link>
                        ) : (
                          <span className="truncate block">{m.title}</span>
                        )}
                      </td>
                      <td className="py-2 px-2">{m.status}</td>
                      <td className="py-2 px-2">{m.category ?? "—"}</td>
                      <td className="py-2 px-2">{m.endDate ? new Date(m.endDate).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
