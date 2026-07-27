import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Copy, KeyRound, Pencil, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from "lucide-react";
import {
  createCustomApiKey,
  deleteCustomApiKey,
  fetchCustomApiKeys,
  fetchModels,
  fetchApiKey,
  regenerateApiKey,
  rotateCustomApiKey,
  setApiKey,
  testApiKey,
  updateCustomApiKey,
  type ApiKeyPolicyInput,
  type ManagedApiKey,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface FormState {
  name: string;
  key: string;
  modelAllowlist: string[];
  dailyTokenLimit: string;
  dailyTokenLimitUnit: LimitUnit;
  monthlyTokenLimit: string;
  monthlyTokenLimitUnit: LimitUnit;
  expiresAt: string;
}

type LimitUnit = "million" | "billion" | "trillion";

const limitUnits: Record<LimitUnit, { label: string; multiplier: number }> = {
  million: { label: "Million", multiplier: 1_000_000 },
  billion: { label: "Billion", multiplier: 1_000_000_000 },
  trillion: { label: "Trillion", multiplier: 1_000_000_000_000 },
};

const emptyForm = (): FormState => ({
  name: "",
  key: "",
  modelAllowlist: [],
  dailyTokenLimit: "",
  dailyTokenLimitUnit: "million",
  monthlyTokenLimit: "",
  monthlyTokenLimitUnit: "million",
  expiresAt: "",
});

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function limitLabel(used: number, limit: number | null, unit: string) {
  return limit ? `${formatNumber(used)} / ${formatNumber(limit)} ${unit}` : `Unlimited (${formatNumber(used)} ${unit})`;
}

function toForm(key: ManagedApiKey): FormState {
  return {
    name: key.name,
    key: "",
    modelAllowlist: key.modelAllowlist,
    ...limitFormValue("dailyTokenLimit", key.dailyTokenLimit),
    ...limitFormValue("monthlyTokenLimit", key.monthlyTokenLimit),
    expiresAt: key.expiresAt ? new Date(key.expiresAt).toISOString().slice(0, 16) : "",
  };
}

function limitFormValue(field: "dailyTokenLimit" | "monthlyTokenLimit", value: number | null): Pick<FormState, typeof field | `${typeof field}Unit`> {
  const unit = value && value % limitUnits.trillion.multiplier === 0
    ? "trillion"
    : value && value % limitUnits.billion.multiplier === 0
      ? "billion"
      : "million";
  const multiplier = limitUnits[unit].multiplier;
  return {
    [field]: value ? String(value / multiplier) : "",
    [`${field}Unit`]: unit,
  } as Pick<FormState, typeof field | `${typeof field}Unit`>;
}

function policyInput(form: FormState): ApiKeyPolicyInput {
  const parseLimit = (value: string, unit: LimitUnit) => value ? Number(value) * limitUnits[unit].multiplier : null;
  return {
    name: form.name.trim(),
    ...(form.key.trim() ? { key: form.key.trim() } : {}),
    modelAllowlist: form.modelAllowlist,
    dailyTokenLimit: parseLimit(form.dailyTokenLimit, form.dailyTokenLimitUnit),
    monthlyTokenLimit: parseLimit(form.monthlyTokenLimit, form.monthlyTokenLimitUnit),
    expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
  };
}

interface ApiKeyProps {
  embedded?: boolean;
}

export default function ApiKey({ embedded = false }: ApiKeyProps) {
  const [apiKey, setApiKeyState] = useState(localStorage.getItem("api_key") || "pool-proxy-secret-key");
  const [source, setSource] = useState("browser");
  const [showKey, setShowKey] = useState(false);
  const [valid, setValid] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<ManagedApiKey[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const { message, setMessage: setTimedMessage, clearMessage } = useTimedMessage<string>(null, 3500);
  const [error, setError] = useState<string | null>(null);

  function notify(text: string) {
    setTimedMessage(text);
    setError(null);
  }

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  function saveToBrowser(key = apiKey) {
    localStorage.setItem("api_key", key);
    setApiKeyState(key);
  }

  async function loadKey() {
    const res = await fetchApiKey() as { key: string; source: string };
    setApiKeyState(res.key);
    setSource(res.source);
    saveToBrowser(res.key);
    setValid(true);
  }

  async function loadManagedKeys() {
    const [keyData, modelData] = await Promise.all([fetchCustomApiKeys(), fetchModels()]);
    setKeys(keyData.data);
    setModels(modelData.data.map((model: { id: string }) => model.id));
  }

  useEffect(() => {
    Promise.all([loadKey(), loadManagedKeys()]).catch(fail);
  }, []);

  async function handleSavePrimary() {
    try {
      const res = await setApiKey(apiKey) as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("Primary API key saved and activated.");
    } catch (err) {
      fail(err);
    }
  }

  async function handleRegeneratePrimary() {
    if (!confirm("Regenerate the primary API key? The previous generated key will stop working.")) return;
    try {
      const res = await regenerateApiKey() as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("New primary API key generated and activated.");
    } catch (err) {
      fail(err);
    }
  }

  async function handleTest() {
    try {
      const res = await testApiKey(apiKey) as { valid: boolean };
      setValid(res.valid);
      notify(res.valid ? "API key is valid." : "API key is invalid or blocked by policy.");
    } catch (err) {
      fail(err);
    }
  }

  function toggleModel(model: string) {
    setForm((current) => ({
      ...current,
      modelAllowlist: current.modelAllowlist.includes(model)
        ? current.modelAllowlist.filter((item) => item !== model)
        : [...current.modelAllowlist, model],
    }));
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm());
    setRevealedKey(null);
  }

  function openCreateDialog() {
    resetForm();
    setFormDialogOpen(true);
  }

  function openEditDialog(key: ManagedApiKey) {
    setEditingId(key.id);
    setForm(toForm(key));
    setRevealedKey(null);
    setFormDialogOpen(true);
  }

  function closeFormDialog() {
    setFormDialogOpen(false);
    resetForm();
  }

  async function handleSaveManaged() {
    try {
      const data = policyInput(form);
      if (!data.name) throw new Error("Name is required");
      if (editingId === null) {
        const result = await createCustomApiKey(data);
        setRevealedKey(result.key);
        notify("Custom API key created. Copy it now; it cannot be revealed again.");
      } else {
        await updateCustomApiKey(editingId, data);
        notify("API key policy updated.");
      }
      await loadManagedKeys();
      if (editingId !== null) resetForm();
      setFormDialogOpen(false);
    } catch (err) {
      fail(err);
    }
  }

  async function handleRotate(key: ManagedApiKey) {
    if (!confirm(`Rotate '${key.name}'? The existing value will stop working immediately.`)) return;
    try {
      const result = await rotateCustomApiKey(key.id);
      setRevealedKey(result.key);
      notify("API key rotated. Copy the new value now; it cannot be revealed again.");
      await loadManagedKeys();
    } catch (err) {
      fail(err);
    }
  }

  async function handleDelete(key: ManagedApiKey) {
    if (!confirm(`Delete '${key.name}'? This cannot be undone.`)) return;
    try {
      await deleteCustomApiKey(key.id);
      if (editingId === key.id) closeFormDialog();
      await loadManagedKeys();
      notify("Custom API key deleted.");
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="space-y-6">
      {!embedded && <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">API Keys</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">Create scoped keys with model ACLs, quotas, expiry, and hit limits.</p>
      </div>}

      {(message || error) && <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>{message || error}</div>}

      {revealedKey && (
        <Card className="border-[var(--success)]/50">
          <CardHeader><CardTitle className="text-base">Copy the new API key now</CardTitle><CardDescription>This full value is shown only once.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row"><Input value={revealedKey} readOnly className="font-mono" /><Button variant="outline" onClick={() => navigator.clipboard.writeText(revealedKey).then(() => notify("API key copied."))}><Copy className="h-4 w-4" /> Copy</Button><Button variant="ghost" onClick={() => setRevealedKey(null)}><X className="h-4 w-4" /> Hide</Button></CardContent>
        </Card>
      )}

      <Card className="border-[var(--border)]">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" /> Primary API Key</CardTitle><CardDescription>Source: <span className="font-mono">{source}</span>. This unrestricted owner key remains available.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2"><Input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => { setApiKeyState(event.target.value); setValid(null); }} className="font-mono" /><Button variant="outline" size="icon" onClick={() => setShowKey(!showKey)}>{showKey ? "Hide" : "Show"}</Button><Button variant="outline" size="icon" onClick={() => navigator.clipboard.writeText(apiKey).then(() => notify("API key copied."))}><Copy className="h-4 w-4" /></Button></div>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm">Status: <b>{valid === true ? "valid" : valid === false ? "invalid" : "not tested"}</b></span><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => loadKey().catch(fail)}>Load</Button><Button variant="outline" size="sm" onClick={handleTest}>Test</Button><Button variant="outline" size="sm" onClick={handleRegeneratePrimary}><RefreshCw className="h-4 w-4" /> Generate</Button><Button size="sm" onClick={handleSavePrimary}><Save className="h-4 w-4" /> Save</Button></div></div>
        </CardContent>
      </Card>

      <Card className="border-[var(--border)]">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> Custom API Keys</CardTitle><CardDescription>Usage counters include successful proxy requests only.</CardDescription></div>
          <Button size="sm" onClick={openCreateDialog}><Plus className="h-4 w-4" /> Add key</Button>
        </CardHeader>
          <CardContent className="space-y-3">
            {keys.length === 0 && <p className="text-sm text-[var(--muted-foreground)]">No custom API keys created.</p>}
            {keys.map((key) => {
              const expired = key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now();
              return <div key={key.id} className="rounded-lg border border-[var(--border)] p-4"><div className="flex flex-col justify-between gap-3 sm:flex-row"><div className="space-y-2"><div className="flex flex-wrap items-center gap-2"><b>{key.name}</b><Badge variant={expired ? "error" : "success"}>{expired ? "Expired" : "Active"}</Badge><span className="font-mono text-xs text-[var(--muted-foreground)]">{key.keyPrefix}</span></div><div className="grid gap-x-5 gap-y-1 text-xs text-[var(--muted-foreground)] sm:grid-cols-2"><span>Daily: {limitLabel(key.dailyTokens, key.dailyTokenLimit, "tokens")}</span><span>Monthly: {limitLabel(key.monthlyTokens, key.monthlyTokenLimit, "tokens")}</span><span>Expires: {formatDate(key.expiresAt)}</span></div><div className="flex flex-wrap gap-1">{key.modelAllowlist.length === 0 ? <Badge variant="secondary">All models</Badge> : key.modelAllowlist.map((model) => <Badge key={model} variant="outline">{model}</Badge>)}</div></div><div className="flex gap-1"><Button variant="ghost" size="icon" title="Edit" onClick={() => openEditDialog(key)}><Pencil className="h-4 w-4" /></Button><Button variant="ghost" size="icon" title="Rotate" onClick={() => handleRotate(key)}><RefreshCw className="h-4 w-4" /></Button><Button variant="ghost" size="icon" title="Delete" onClick={() => handleDelete(key)}><Trash2 className="h-4 w-4" /></Button></div></div></div>;
            })}
          </CardContent>
      </Card>

      <Dialog open={formDialogOpen} onOpenChange={(open) => !open && closeFormDialog()}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>{editingId === null ? "Create custom API key" : "Edit API key policy"}</DialogTitle><DialogDescription>Blank limits and model list mean unlimited access.</DialogDescription></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1 text-sm"><span>Name</span><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Production app" /></label>
            {editingId === null && <label className="block space-y-1 text-sm"><span>Custom key value</span><Input value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} placeholder="Auto-generate when blank" className="font-mono" /></label>}
            <LimitInput label="Daily token limit" value={form.dailyTokenLimit} unit={form.dailyTokenLimitUnit} onValueChange={(value) => setForm({ ...form, dailyTokenLimit: value })} onUnitChange={(unit) => setForm({ ...form, dailyTokenLimitUnit: unit })} />
            <LimitInput label="Monthly token limit" value={form.monthlyTokenLimit} unit={form.monthlyTokenLimitUnit} onValueChange={(value) => setForm({ ...form, monthlyTokenLimit: value })} onUnitChange={(unit) => setForm({ ...form, monthlyTokenLimitUnit: unit })} />
            <label className="block space-y-1 text-sm"><span>Expires at</span><Input type="datetime-local" value={form.expiresAt} onChange={(event) => setForm({ ...form, expiresAt: event.target.value })} /></label>
            <div className="space-y-2 sm:col-span-2"><div className="flex items-center justify-between text-sm"><span>Model allowlist</span><Button variant="ghost" size="sm" onClick={() => setForm({ ...form, modelAllowlist: [] })}>Allow all</Button></div><Select value="" onChange={(event) => { if (event.target.value) toggleModel(event.target.value); }}><option value="">Add allowed model</option>{models.filter((model) => !form.modelAllowlist.includes(model)).map((model) => <option key={model} value={model}>{model}</option>)}</Select><div className="flex flex-wrap gap-1">{form.modelAllowlist.length === 0 ? <span className="text-xs text-[var(--muted-foreground)]">All available models are allowed.</span> : form.modelAllowlist.map((model) => <button key={model} onClick={() => toggleModel(model)} className="rounded-full border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--secondary)]">{model} ×</button>)}</div></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={closeFormDialog}>Cancel</Button><Button onClick={handleSaveManaged}>{editingId === null ? <Plus className="h-4 w-4" /> : <Save className="h-4 w-4" />}{editingId === null ? "Create key" : "Save policy"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LimitInput({ label, value, unit, onValueChange, onUnitChange }: { label: string; value: string; unit: LimitUnit; onValueChange: (value: string) => void; onUnitChange: (unit: LimitUnit) => void }) {
  return <label className="block space-y-1 text-sm"><span>{label}</span><div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2"><Input type="number" min="1" step="any" value={value} onChange={(event) => onValueChange(event.target.value)} placeholder="Unlimited" /><Select value={unit} onChange={(event) => onUnitChange(event.target.value as LimitUnit)}>{Object.entries(limitUnits).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}</Select></div></label>;
}
