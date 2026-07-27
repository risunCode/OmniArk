import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchAvailableProviders, fetchDashboardStats, fetchRequests } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";

interface RequestItem {
  id: number;
  provider: string;
  model: string | null;
  status: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens?: number | null;
  createdAt: string;
}

interface UsageTopologyProps {
  period: string;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatCost(value: number) {
  return `~$${value.toFixed(4)}`;
}

function timeAgo(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function hoursForPeriod(period: string): number | undefined {
  if (period === "1d") return 24;
  if (period === "7d") return 24 * 7;
  if (period === "30d") return 24 * 30;
  return undefined;
}

export default function UsageTopology({ period }: UsageTopologyProps) {
  const [stats, setStats] = useState<any>(null);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [activeProviders, setActiveProviders] = useState<string[]>([]);

  async function load() {
    const hours = hoursForPeriod(period);
    const range = period === "all" ? "all" : undefined;
    const [statsResult, requestResult, providerResult] = await Promise.all([
      fetchDashboardStats(hours, range),
      fetchRequests(1, 20),
      fetchAvailableProviders(),
    ]);
    setStats(statsResult);
    setRequests((requestResult as { data: RequestItem[] }).data || []);
    setAvailableProviders(providerResult.data || []);
  }

  useEffect(() => {
    load().catch(() => {});
  }, [period]);

  useWsEvent(["request_started", "request_log", "request_error"], (message) => {
    const data = message.data as RequestItem;
    if (data.provider) {
      setActiveProviders((current) => [...new Set([...current, data.provider])]);
      setTimeout(() => setActiveProviders((current) => current.filter((provider) => provider !== data.provider)), 2_500);
    }
    if (message.type === "request_log") {
      setRequests((current) => [data, ...current.filter((request) => request.id !== data.id)].slice(0, 20));
    }
    load().catch(() => {});
  });

  const providers = useMemo(
    () => [...new Set([...availableProviders, ...requests.map((request) => request.provider).filter(Boolean)])],
    [availableProviders, requests],
  );
  const totals = stats?.tokens || {};
  const totalRequests = Number(stats?.requests?.total || 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Total requests" value={formatNumber(totalRequests)} color="var(--foreground)" />
        <Metric label="Total input tokens" value={formatNumber(Number(totals.prompt || 0))} color="var(--chart-5)" />
        <Metric label="Cached tokens" value={formatNumber(Number(totals.cached || 0))} color="var(--info)" />
        <Metric label="Output tokens" value={formatNumber(Number(totals.completion || 0))} color="var(--success)" />
        <Metric label="Est. cost" value={formatCost(Number(totals.estimatedCost || 0))} color="var(--warning)" caption="Estimated, not actual billing" />
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
        <Card className="min-h-[500px] overflow-hidden border-[var(--border)]">
          <CardHeader><CardTitle className="text-base">Provider traffic</CardTitle></CardHeader>
          <CardContent className="h-[420px] p-4">
            <div className="topology-grid relative h-full overflow-hidden rounded-lg border border-[var(--border)]">
              <div className={`topology-core ${activeProviders.length > 0 ? "topology-core-active" : ""}`}>
                <img src="/omniark.svg" alt="OmniArk" className="h-7 w-7" />
                <span>OmniArk</span>
                {activeProviders.length > 0 && <b>{activeProviders.length}</b>}
              </div>
              {providers.length === 0 && <p className="absolute inset-0 flex items-center justify-center text-sm text-[var(--muted-foreground)]">No active providers configured.</p>}
              {providers.map((provider, index) => {
                const angle = (Math.PI * 2 * index) / providers.length - Math.PI / 2;
                const x = 50 + Math.cos(angle) * 37;
                const y = 50 + Math.sin(angle) * 34;
                const active = activeProviders.includes(provider);
                return <div key={provider} className={`topology-provider ${active ? "topology-provider-active" : ""}`} style={{ left: `${x}%`, top: `${y}%` }}>
                  <span className="topology-line" style={{ "--angle": `${angle + Math.PI}` } as CSSProperties} />
                  <span className="topology-provider-dot">{provider.slice(0, 2).toUpperCase()}</span>
                  <span>{provider}</span>
                  {active && <i className="topology-particle" />}
                </div>;
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-[500px] border-[var(--border)]">
          <CardHeader><CardTitle className="text-base">Recent requests</CardTitle></CardHeader>
          <CardContent className="max-h-[420px] overflow-y-auto p-0">
            <table className="w-full text-xs"><thead className="sticky top-0 bg-[var(--card)]"><tr className="border-b border-[var(--border)]"><th className="px-4 py-2 text-left">Model</th><th className="px-2 py-2 text-right">In / Out</th><th className="px-4 py-2 text-right">When</th></tr></thead><tbody>
              {requests.map((request) => <tr key={request.id} className="border-b border-[var(--border)]/60"><td className="max-w-[150px] truncate px-4 py-2 font-mono"><span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${request.status === "success" ? "bg-[var(--success)]" : "bg-[var(--error)]"}`} />{request.model || "unknown"}</td><td className="whitespace-nowrap px-2 py-2 text-right"><span className="text-[var(--chart-5)]">{formatNumber(request.promptTokens || 0)}↑</span> <span className="text-[var(--success)]">{formatNumber(request.completionTokens || 0)}↓</span></td><td className="whitespace-nowrap px-4 py-2 text-right text-[var(--muted-foreground)]">{timeAgo(request.createdAt)}</td></tr>)}
              {requests.length === 0 && <tr><td colSpan={3} className="p-8 text-center text-[var(--muted-foreground)]">No requests yet</td></tr>}
            </tbody></table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value, color, caption }: { label: string; value: string; color: string; caption?: string }) {
  return <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">{label}</p><p className="mt-2 text-2xl font-bold" style={{ color }}>{value}</p>{caption && <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">{caption}</p>}</CardContent></Card>;
}
