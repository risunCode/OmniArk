import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Copy, Cpu, Loader2, Play, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchModels, testUpstreamModel } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface ModelData {
  id: string;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
}

interface UpstreamTestResult {
  success: boolean;
  message: string;
}

const providerColors: Record<string, string> = {
  codex: "var(--chart-1)",
  qoder: "var(--chart-4)",
  byok: "var(--chart-2)",
};

function formatNumber(value: number | undefined): string {
  if (!value) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function providerName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Models() {
  const [models, setModels] = useState<ModelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, UpstreamTestResult>>({});
  const { message: copiedModel, setMessage: setCopiedModel } = useTimedMessage<string>(null, 1_500);

  useEffect(() => {
    fetchModels()
      .then((response: { data: ModelData[] }) => setModels(response.data || []))
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, []);

  const groupedModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = models.filter((model) => !query || model.id.toLowerCase().includes(query) || model.owned_by.toLowerCase().includes(query));
    return filtered.reduce<Record<string, ModelData[]>>((groups, model) => {
      (groups[model.owned_by] ||= []).push(model);
      return groups;
    }, {});
  }, [models, search]);

  async function copyModelId(modelId: string) {
    await navigator.clipboard.writeText(modelId);
    setCopiedModel(modelId);
  }

  async function testModel(modelId: string) {
    setTesting(modelId);
    try {
      const result = await testUpstreamModel(modelId);
      const message = result.success
        ? `${result.provider ?? "Upstream"} · ${result.latencyMs ?? 0}ms`
        : result.error || "Test failed";
      setTestResults((current) => ({
        ...current,
        [modelId]: { success: result.success, message },
      }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [modelId]: {
          success: false,
          message: error instanceof Error ? error.message : "Test failed",
        },
      }));
    } finally {
      setTesting(null);
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-b-2 border-[var(--primary)]" /></div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Models</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">{models.length} models across {Object.keys(groupedModels).length} providers</p>
      </div>

      <Card className="border-[var(--border)]"><CardContent className="p-4"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models or providers..." className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] py-2 pr-4 pl-10 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:ring-2 focus:ring-[var(--primary)] focus:outline-none" /></div></CardContent></Card>

      {Object.entries(groupedModels).map(([provider, providerModels]) => {
        const color = providerColors[provider] || "var(--muted-foreground)";
        return <section key={provider} className="space-y-3">
          <div className="flex items-center gap-3"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }} /><h2 className="text-lg font-semibold text-[var(--foreground)]">{providerName(provider)}</h2><Badge variant="outline">{providerModels.length} models</Badge></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {providerModels.map((model) => {
              const result = testResults[model.id];
              const isTesting = testing === model.id;
              return (
                <Card key={model.id} className="group border-[var(--border)] transition-colors hover:border-[var(--primary)]/60">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <CardTitle className="break-all text-sm leading-5">{model.id}</CardTitle>
                      <button type="button" title={`Copy ${model.id}`} onClick={() => copyModelId(model.id)} className="rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
                        {copiedModel === model.id ? <Check className="h-4 w-4 text-[var(--success)]" /> : <Copy className="h-4 w-4" />}
                      </button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <ModelMetric label="Context" value={formatNumber(model.context_window)} />
                      <ModelMetric label="Max output" value={formatNumber(model.max_output)} />
                    </div>
                    <div className="flex gap-1">
                      {model.thinking && <Badge variant="info">Thinking</Badge>}
                      <Badge variant="secondary">{providerName(provider)}</Badge>
                    </div>
                    <button type="button" disabled={testing !== null} onClick={() => testModel(model.id)} className="flex w-full items-center justify-center gap-2 rounded-md border border-[var(--info)]/30 px-3 py-2 text-xs font-medium text-[var(--info)] transition-colors hover:bg-[var(--info)]/10 disabled:opacity-50">
                      {isTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      {isTesting ? "Testing upstream…" : "Test upstream"}
                    </button>
                    {result && <p className={`flex items-center gap-1 text-xs ${result.success ? "text-[var(--success)]" : "text-[var(--error)]"}`}>
                      {result.success ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                      {result.message}
                    </p>}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>;
      })}

      {Object.keys(groupedModels).length === 0 && <Card className="border-[var(--border)]"><CardContent className="flex flex-col items-center py-12 text-[var(--muted-foreground)]"><Cpu className="mb-4 h-12 w-12" /><p>No models found</p></CardContent></Card>}
    </div>
  );
}

function ModelMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-[var(--secondary)] p-2"><p className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">{label}</p><p className="mt-1 text-sm font-medium text-[var(--foreground)]">{value}</p></div>;
}
