import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Cloud, Globe, Plus, RefreshCw, Triangle, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchApi } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

type ProxyType = "http" | "vercel" | "cloudflare";

interface ProxyEntry {
  id: number;
  url: string;
  type: ProxyType;
  label: string | null;
  status: "active" | "disabled" | "error";
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  successCount: number;
  failCount: number;
}

interface ProxyPoolStatus {
  count: number;
  activeCount: number;
  proxies: ProxyEntry[];
}

function getProxyTypeLabel(type: ProxyType) {
  if (type === "vercel") return "Vercel relay";
  if (type === "cloudflare") return "Cloudflare relay";
  return "HTTP proxy";
}

export default function ProxyPool() {
  const [pool, setPool] = useState<ProxyPoolStatus>({ count: 0, activeCount: 0, proxies: [] });
  const [loading, setLoading] = useState(true);
  const [bulkText, setBulkText] = useState("");
  const [proxyType, setProxyType] = useState<ProxyType>("http");
  const [checking, setChecking] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3_000);

  const loadPool = useCallback(async () => {
    try {
      setPool(await fetchApi<ProxyPoolStatus>("/api/proxy-pool/pool"));
    } catch {
      setPool({ count: 0, activeCount: 0, proxies: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPool(); }, [loadPool]);

  const addProxies = async () => {
    const proxies = bulkText.split("\n").map((line) => line.trim()).filter(Boolean);
    if (proxies.length === 0) return setMessage("Paste at least one proxy or relay URL");
    try {
      const result = await fetchApi<{ added: number; invalid: string[] }>("/api/proxy-pool/pool", {
        method: "POST",
        body: JSON.stringify({ proxies, type: proxyType }),
      });
      setBulkText("");
      setMessage(result.invalid.length > 0 ? `${result.added} added; ${result.invalid.length} invalid URL` : `${result.added} ${getProxyTypeLabel(proxyType)} added`);
      loadPool();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to add proxy");
    }
  };

  const updateStatus = async (id: number, status: ProxyEntry["status"]) => {
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, { method: "PUT", body: JSON.stringify({ status }) });
      loadPool();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update proxy");
    }
  };

  const removeProxy = async (id: number) => {
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, { method: "DELETE" });
      setMessage("Proxy removed");
      loadPool();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove proxy");
    }
  };

  const checkProxy = async (id: number) => {
    try {
      const result = await fetchApi<{ ok: boolean; latencyMs: number; error?: string }>(`/api/proxy-pool/pool/${id}/check`, { method: "POST" });
      setMessage(result.ok ? `Healthy · ${result.latencyMs}ms` : `Test failed: ${result.error ?? "unknown error"}`);
      loadPool();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Test failed");
    }
  };

  const checkAll = async () => {
    setChecking(true);
    try {
      const result = await fetchApi<{ checked: number }>("/api/proxy-pool/pool/check-all", { method: "POST" });
      setMessage(`${result.checked} entries tested`);
      loadPool();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Tests failed");
    } finally {
      setChecking(false);
    }
  };

  const clearPool = async () => {
    if (!confirm("Remove every proxy and relay from this pool?")) return;
    try {
      await fetchApi("/api/proxy-pool/pool", { method: "DELETE" });
      setMessage("Proxy pool cleared");
      loadPool();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to clear pool");
    }
  };

  return <div className="space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div><h1 className="text-2xl font-bold text-[var(--foreground)]">Proxy Pool</h1><p className="mt-1 text-sm text-[var(--muted-foreground)]">Route upstream traffic through HTTP proxies or Vercel and Cloudflare relays.</p></div>
      <div className="flex items-center gap-2"><span className="text-sm text-[var(--muted-foreground)]">{pool.activeCount}/{pool.count} active</span><Button variant="outline" size="sm" onClick={checkAll} disabled={checking}><RefreshCw className={`mr-1 h-3 w-3 ${checking ? "animate-spin" : ""}`} />Test all</Button>{pool.count > 0 && <Button variant="outline" size="sm" onClick={clearPool}><Trash2 className="mr-1 h-3 w-3" />Clear</Button>}</div>
    </div>

    {message && <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-2 text-sm text-[var(--foreground)]">{message}</div>}

    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4" />Add routing endpoint</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <ProxyTypeOption type="http" selected={proxyType} onSelect={setProxyType} icon={Globe} title="HTTP proxy" description="Standard HTTP/HTTPS CONNECT proxy" />
          <ProxyTypeOption type="vercel" selected={proxyType} onSelect={setProxyType} icon={Triangle} title="Vercel proxy" description="Relay URL using x-relay headers" />
          <ProxyTypeOption type="cloudflare" selected={proxyType} onSelect={setProxyType} icon={Cloud} title="Cloudflare proxy" description="Worker relay using x-relay headers" />
        </div>
        <textarea className="h-[120px] w-full resize-none rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/20" placeholder={proxyType === "http" ? "One HTTP proxy per line\n\nhttp://user:pass@host:port\nhttp://host:port" : "One deployed relay URL per line\n\nhttps://your-relay.example.com"} value={bulkText} onChange={(event) => setBulkText(event.target.value)} />
        <div className="flex flex-col justify-between gap-3 rounded-xl bg-[var(--secondary)]/50 p-3 text-xs text-[var(--muted-foreground)] sm:flex-row sm:items-center"><p>{proxyType === "http" ? "HTTP proxies are passed directly through Bun's proxy transport." : "Relay tests call the relay with a safe httpbin target; upstream traffic retains its method, headers, and body."}</p><Button onClick={addProxies}><Upload className="mr-2 h-4 w-4" />Add to pool</Button></div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Globe className="h-4 w-4" />Routing endpoints</CardTitle></CardHeader>
      <CardContent>{loading ? <p className="text-sm text-[var(--muted-foreground)]">Loading...</p> : pool.proxies.length === 0 ? <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">No endpoints configured. Add an HTTP proxy, Vercel relay, or Cloudflare relay above.</p> : <div className="space-y-2">{pool.proxies.map((proxy) => <ProxyRow key={proxy.id} proxy={proxy} onCheck={checkProxy} onToggle={updateStatus} onRemove={removeProxy} />)}</div>}</CardContent>
    </Card>
  </div>;
}

function ProxyTypeOption({ type, selected, onSelect, icon: Icon, title, description }: { type: ProxyType; selected: ProxyType; onSelect: (type: ProxyType) => void; icon: typeof Globe; title: string; description: string }) {
  const active = selected === type;
  return <label className={`relative flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${active ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-[var(--glass-border)] bg-[var(--glass-bg)] hover:bg-[var(--glass-hover)]"}`}><input type="checkbox" className="sr-only" checked={active} onChange={() => onSelect(type)} /><span className={`grid h-9 w-9 place-items-center rounded-xl ${active ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "bg-[var(--secondary)] text-[var(--muted-foreground)]"}`}><Icon className="h-4 w-4" /></span><span><span className="block text-sm font-semibold text-[var(--foreground)]">{title}</span><span className="block text-xs text-[var(--muted-foreground)]">{description}</span></span>{active && <CheckCircle2 className="absolute right-3 top-3 h-4 w-4 text-[var(--primary)]" />}</label>;
}

function ProxyRow({ proxy, onCheck, onToggle, onRemove }: { proxy: ProxyEntry; onCheck: (id: number) => void; onToggle: (id: number, status: ProxyEntry["status"]) => void; onRemove: (id: number) => void }) {
  const statusColor = proxy.status === "active" ? "bg-[var(--success)]" : proxy.status === "error" ? "bg-[var(--error)]" : "bg-[var(--warning)]";
  const protocol = proxy.type === "http" ? maskUrl(proxy.url) : proxy.url;
  return <div className="flex flex-col gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3 transition hover:bg-[var(--glass-hover)] sm:flex-row sm:items-center"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--secondary)] text-[var(--primary)]">{proxy.type === "vercel" ? <Triangle className="h-4 w-4" /> : proxy.type === "cloudflare" ? <Cloud className="h-4 w-4" /> : <Globe className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate font-mono text-sm text-[var(--foreground)]">{protocol}</p><span className="rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">{getProxyTypeLabel(proxy.type)}</span><span className="flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]"><i className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />{proxy.status}</span></div><p className="mt-1 text-xs text-[var(--muted-foreground)]">{proxy.latencyMs == null ? "Not tested" : `${proxy.latencyMs}ms`} · {proxy.successCount} passed · {proxy.failCount} failed {proxy.errorMessage ? `· ${proxy.errorMessage}` : ""}</p></div><div className="flex shrink-0 items-center gap-1"><Button variant="ghost" size="sm" onClick={() => onCheck(proxy.id)} title="Test endpoint"><RefreshCw className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="sm" onClick={() => onToggle(proxy.id, proxy.status === "active" ? "disabled" : "active")} title={proxy.status === "active" ? "Disable" : "Enable"}>{proxy.status === "active" ? "Disable" : "Enable"}</Button><Button variant="ghost" size="sm" onClick={() => onRemove(proxy.id)} title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button></div></div>;
}

function maskUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.password ? `${parsed.protocol}//${parsed.username}:***@${parsed.host}` : `${parsed.protocol}//${parsed.host}`;
  } catch { return url; }
}
