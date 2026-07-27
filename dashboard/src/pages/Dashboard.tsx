import StatsCards from "@/components/dashboard/StatsCards";
import ApiKey from "@/pages/ApiKey";
import { useEffect, useRef, useState } from "react";
import { fetchDashboardStats } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";
import { Sparkles, Wifi } from "lucide-react";

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);

  async function load() {
    await fetchDashboardStats(undefined, "all").then(setStats).catch(() => setStats(null));
  }

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); }, 500);
  };

  useEffect(() => {
    load();
    return () => { if (reloadRef.current) clearTimeout(reloadRef.current); };
  }, []);

  useWsEvent(
    [
      "request_log",
      "request_error",
      "account_status",
      "account_updated",
      "account_created",
      "account_deleted",
      "accounts_updated",
      "accounts_bulk_created",
      "provider_toggled",
    ],
    scheduleReload,
  );

  const totalRequests = Number(stats?.requests?.total || 0);
  const successRequests = Number(stats?.requests?.success || 0);
  const dashboardStats = {
    accounts: {
      active: Number(stats?.pool?.active || 0),
      total: Number(stats?.pool?.total || 0),
    },
    requests: totalRequests,
    successRate: totalRequests > 0 ? Number(((successRequests / totalRequests) * 100).toFixed(1)) : 0,
    totalTokens: Number(stats?.tokens?.total || 0),
  };

  return (
    <div className="space-y-6">
      <div className="os-hero">
        <div className="relative z-10 max-w-2xl">
          <span className="os-kicker"><Sparkles className="h-3 w-3" aria-hidden="true" /> OmniArk Control</span>
          <h1 className="mt-4 text-3xl font-bold text-[var(--foreground)] sm:text-4xl">Your proxy command center.</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-[var(--muted-foreground)]">Manage secured access, provider capacity, and live traffic from one calm, focused workspace.</p>
        </div>
        <div className="relative z-10 mt-5 flex items-center gap-2 text-xs text-[var(--muted-foreground)]"><span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--info)] opacity-65" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--info)]" /></span><Wifi className="h-3.5 w-3.5" aria-hidden="true" /> Live pool telemetry</div>
      </div>

      <StatsCards data={dashboardStats} />

       <ApiKey embedded />
    </div>
  );
}
