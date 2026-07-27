import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, Network, Sparkles } from "lucide-react";
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

interface ProviderState {
  activeUntil: number;
  status: "success" | "error" | "idle";
}

interface InFlightRequest {
  provider: string;
  expiresAt: number;
}

const providerPalette: Record<string, { accent: string; soft: string; label: string }> = {
  codex: { accent: "#a99cff", soft: "#e3deff", label: "Codex" },
  qoder: { accent: "#75baff", soft: "#d7ebff", label: "Qoder" },
  byok: { accent: "#54d6b2", soft: "#d8fff3", label: "BYOK" },
};

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

function providerMeta(provider: string) {
  return providerPalette[provider] || { accent: "#f6be67", soft: "#fff0cf", label: provider };
}

function edgePath(x: number, y: number) {
  return `M 500 300 L ${x} ${y}`;
}

export default function UsageTopology({ period }: UsageTopologyProps) {
  const [stats, setStats] = useState<any>(null);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [providerState, setProviderState] = useState<Record<string, ProviderState>>({});
  const [inFlightRequests, setInFlightRequests] = useState<Record<string, InFlightRequest>>({});
  const [now, setNow] = useState(Date.now());

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

  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      setInFlightRequests((current) => Object.fromEntries(Object.entries(current).filter(([, request]) => request.expiresAt > currentTime)));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useWsEvent(["request_started", "request_log", "request_error"], (message) => {
    const data = message.data as RequestItem;
    if (data.provider) {
      setProviderState((current) => ({
        ...current,
        [data.provider]: {
          activeUntil: Date.now() + 5_500,
          status: message.type === "request_error" ? "error" : "success",
        },
      }));
    }
    if (message.type === "request_started" && data.provider && data.id != null) {
      setInFlightRequests((current) => ({
        ...current,
        [String(data.id)]: { provider: data.provider, expiresAt: Date.now() + 5 * 60_000 },
      }));
    }
    if ((message.type === "request_log" || message.type === "request_error") && data.id != null) {
      setInFlightRequests((current) => {
        const next = { ...current };
        delete next[String(data.id)];
        return next;
      });
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
  const activeCount = providers.filter((provider) => providerState[provider]?.activeUntil > now).length;
  const inFlightCount = Object.values(inFlightRequests).filter((request) => request.expiresAt > now).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Total Requests" value={formatNumber(totalRequests)} color="var(--foreground)" icon={Activity} />
        <Metric label="Input Tokens" value={formatNumber(Number(totals.prompt || 0))} color="var(--chart-5)" icon={ArrowDownLeft} />
        <Metric label="Cached Tokens" value={formatNumber(Number(totals.cached || 0))} color="var(--info)" icon={Sparkles} />
        <Metric label="Output Tokens" value={formatNumber(Number(totals.completion || 0))} color="var(--success)" icon={ArrowUpRight} />
        <Metric label="Estimated Cost" value={formatCost(Number(totals.estimatedCost || 0))} color="var(--warning)" caption="Estimated, not billing" icon={Network} />
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(340px,1fr)]">
        <Card className="min-h-[510px] overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div><p className="os-section-title">Live Routing Map</p><CardTitle className="mt-1 text-lg">Provider Traffic</CardTitle></div>
            <div className="flex items-center gap-2 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] px-2.5 py-1 text-[11px] text-[var(--muted-foreground)]"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--info)] opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--info)]" /></span>{inFlightCount > 0 ? `${inFlightCount} in flight` : "Listening"}</div>
          </CardHeader>
          <CardContent className="h-[425px] p-3 pt-0 sm:p-4 sm:pt-0">
            <TopologyCanvas providers={providers} providerState={providerState} now={now} activeCount={activeCount} />
          </CardContent>
        </Card>

        <Card className="min-h-[510px] overflow-hidden">
          <CardHeader><CardTitle className="text-base">Recent requests</CardTitle></CardHeader>
          <CardContent className="max-h-[425px] overflow-y-auto p-0">
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

function TopologyCanvas({ providers, providerState, now, activeCount }: { providers: string[]; providerState: Record<string, ProviderState>; now: number; activeCount: number }) {
  return <div className="topology-canvas relative h-full overflow-hidden rounded-2xl border border-[var(--glass-border)]">
    <svg viewBox="0 0 1000 600" role="img" aria-label="Live provider traffic topology" className="h-full w-full">
      <defs>
        <radialGradient id="topology-core-gradient"><stop stopColor="var(--primary)" stopOpacity="0.36" /><stop offset="1" stopColor="var(--primary)" stopOpacity="0" /></radialGradient>
        <filter id="topology-glow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <pattern id="topology-dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--glass-border)" opacity="0.45" /></pattern>
      </defs>
      <rect width="1000" height="600" fill="url(#topology-dots)" />
      <circle cx="500" cy="300" r="175" fill="url(#topology-core-gradient)" opacity={activeCount ? 1 : 0.55} />
      {providers.map((provider, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(providers.length, 1) - Math.PI / 2;
        const x = 500 + Math.cos(angle) * 340;
        const y = 300 + Math.sin(angle) * 202;
        const state = providerState[provider];
        const active = state?.activeUntil > now;
        const path = edgePath(x, y);
        const meta = providerMeta(provider);
        const edgeId = `traffic-edge-${provider}`;
        return <g key={provider}>
          <path d={path} fill="none" stroke="var(--glass-border)" strokeWidth="2" opacity="0.7" />
          {active && <><path d={path} fill="none" stroke={state.status === "error" ? "var(--error)" : "var(--info)"} strokeWidth="11" opacity="0.13" filter="url(#topology-glow)" /><path d={path} fill="none" stroke={state.status === "error" ? "var(--error)" : meta.accent} strokeWidth="3" strokeDasharray="7 9" className="topology-edge-flow" /><path id={edgeId} d={path} fill="none" stroke="none" />{[0, 0.33, 0.66].map((begin) => <circle key={begin} r="5" fill={state.status === "error" ? "var(--error)" : "#ffffff"} filter="url(#topology-glow)"><animateMotion dur="1.45s" begin={`${begin}s`} repeatCount="indefinite"><mpath href={`#${edgeId}`} /></animateMotion><animate attributeName="opacity" values="0;1;1;0" dur="1.45s" begin={`${begin}s`} repeatCount="indefinite" /></circle>)}</>}
          <g transform={`translate(${x} ${y})`} className="topology-provider-node">
            {active && <circle r="62" fill={state.status === "error" ? "var(--error)" : meta.accent} opacity="0.12" className="topology-node-halo" />}
            <rect x="-78" y="-32" width="156" height="64" rx="18" fill="var(--glass-bg-strong)" stroke={active ? (state.status === "error" ? "var(--error)" : meta.accent) : "var(--glass-border)"} strokeWidth={active ? 2 : 1} />
            <rect x="-66" y="-20" width="40" height="40" rx="13" fill={meta.accent} opacity="0.18" />
            <text x="-46" y="6" textAnchor="middle" fill={meta.soft} fontSize="13" fontWeight="800">{provider.slice(0, 2).toUpperCase()}</text>
            <text x="-16" y="-2" fill="var(--foreground)" fontSize="15" fontWeight="700">{meta.label}</text>
            <text x="-16" y="15" fill="var(--muted-foreground)" fontSize="10">{active ? (state.status === "error" ? "needs attention" : "routing now") : "ready"}</text>
            <circle cx="58" cy="-14" r="5" fill={active ? (state.status === "error" ? "var(--error)" : "var(--success)") : "var(--muted-foreground)"} />
          </g>
        </g>;
      })}
      <g transform="translate(500 300)" className={activeCount ? "topology-router-active" : ""}>
        <circle r="77" fill="var(--glass-bg-strong)" stroke="var(--primary)" strokeWidth="2" filter="url(#topology-glow)" />
        <circle r="60" fill="url(#topology-core-gradient)" opacity="0.7" />
        <image href="/omniark.svg" x="-19" y="-32" width="38" height="38" />
        <text y="29" textAnchor="middle" fill="var(--foreground)" fontSize="14" fontWeight="800">OmniArk</text>
        {activeCount > 0 && <g transform="translate(51 -53)"><circle r="14" fill="var(--primary)" /><text y="4" textAnchor="middle" fill="var(--primary-foreground)" fontSize="11" fontWeight="800">{activeCount}</text></g>}
      </g>
    </svg>
    {providers.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--muted-foreground)]">No active providers configured.</div>}
  </div>;
}

function Metric({ label, value, color, caption, icon: Icon }: { label: string; value: string; color: string; caption?: string; icon: typeof Activity }) {
  return <Card><CardContent className="p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--muted-foreground)]">{label}</p><p className="mt-2 text-2xl font-bold tracking-tight tabular-nums" style={{ color }}>{value}</p>{caption && <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">{caption}</p>}</div><span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--secondary)]" style={{ color }}><Icon className="h-4 w-4" aria-hidden="true" /></span></div></CardContent></Card>;
}
