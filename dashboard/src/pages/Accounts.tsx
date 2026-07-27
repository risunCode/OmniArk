import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle as DTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, RefreshCw, ChevronDown, Loader2, Key, Pencil, Trash2, Zap, Lock, Eye, EyeOff } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useWsEvent } from "@/hooks/useWebSocket";
import {
  completeCodexOAuthCallbackUrl,
  createByokProvider,
  deleteByokProvider,
  fetchAccounts,
  fetchApi,
  fetchByokProviders,
  getCodexAuthorize,
  pollCodexOAuthStatus,
  revealByokKey,
  startCodexOAuthProxy,
  stopCodexOAuth,
  testByokProvider,
  updateByokProvider,
  type ByokProvider,
} from "@/lib/api";

type Provider = "codex" | "qoder";

type ByokFormKey = {
  id?: number;
  label: string;
  key: string;
  enabled: boolean;
  status?: string;
  errorMessage?: string | null;
};

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: string;
  quotaLimit?: number;
  quotaRemaining?: number;
}

const providers: Provider[] = ["codex", "qoder"];

function labelProvider(provider: string) {
  if (provider === "codex") return "Codex";
  if (provider === "qoder") return "Qoder";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Accounts() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [addDialogProvider, setAddDialogProvider] = useState<Provider | null>(null);
  const [instantTokens, setInstantTokens] = useState("");
  const [cookieValue, setCookieValue] = useState("");
  const [addMode, setAddMode] = useState<"instant" | "pat" | "apikey">("pat");
  const [codexOauthBusy, setCodexOauthBusy] = useState(false);
  const [codexOauthAuthUrl, setCodexOauthAuthUrl] = useState("");
  const [codexOauthCallbackUrl, setCodexOauthCallbackUrl] = useState("");
  const [byokProviders, setByokProviders] = useState<ByokProvider[]>([]);
  const [byokDialogOpen, setByokDialogOpen] = useState(false);
  const [byokEditId, setByokEditId] = useState<number | null>(null);
  const [byokForm, setByokForm] = useState({
    label: "",
    base_url: "",
    api_key: "",
    format: "auto" as "openai" | "anthropic" | "auto",
    models: "",
    load_balancing_method: "round_robin" as "round_robin" | "sequential" | "least_inflight",
    keys: [{ label: "default", key: "", enabled: true }] as ByokFormKey[],
  });
  const [visibleByokSecrets, setVisibleByokSecrets] = useState<Set<string>>(new Set());
  const [revealingByokSecret, setRevealingByokSecret] = useState<string | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codexOauthPopupRef = useRef<Window | null>(null);
  const codexOauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codexOauthStateRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const accountsRes = await fetchAccounts() as { data: Account[] };
      setAccounts(accountsRes.data || []);

      // Load BYOK providers
      const byokRes = await fetchByokProviders();
      setByokProviders(byokRes.providers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    };
  }, []);

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); }, 800);
  };

  useEffect(() => () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    if (codexOauthPollRef.current) clearInterval(codexOauthPollRef.current);
    if (codexOauthStateRef.current) {
      stopCodexOAuth(codexOauthStateRef.current).catch(() => {});
    }
    codexOauthPopupRef.current?.close();
  }, []);

  useEffect(() => {
    const pollId = codexOauthPollRef.current;
    return () => {
      if (pollId) clearInterval(pollId);
    };
  }, []);

  useWsEvent(["account_status"], scheduleReload);

  useWsEvent(["byok_created", "byok_updated", "byok_deleted"], async () => {
    const byokRes = await fetchByokProviders();
    setByokProviders(byokRes.providers || []);
  });

  function showSuccess(text: string) {
    setMessage(text);
    setError(null);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(() => setMessage(null), 4000);
  }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); setMessage(null); }

  async function handleInstantLogin() {
    if (!instantTokens.trim()) { showError(new Error("Paste refresh tokens (one per line)")); return; }
    const tokens = instantTokens.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (tokens.length === 0) { showError(new Error("No valid tokens found")); return; }

    try {
      const res = await fetchApi<{ success: number; failed: number; errors?: string[] }>("/api/accounts/instant-login", {
        method: "POST",
        body: JSON.stringify({ tokens, provider: addDialogProvider }),
      });
      showSuccess(`Instant login: ${res.success} success, ${res.failed} failed`);
      setInstantTokens("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleCookieLogin() {
    if (!cookieValue.trim()) { showError(new Error("Paste Personal Access Token (PAT)")); return; }
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "qoder",
          personalToken: cookieValue.trim(),
        }),
      });
      showSuccess("Qoder account added successfully");
      setCookieValue("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  function clearCodexOAuthPolling() {
    if (codexOauthPollRef.current) {
      clearInterval(codexOauthPollRef.current);
      codexOauthPollRef.current = null;
    }
  }

  function resetCodexOAuthFlow() {
    clearCodexOAuthPolling();
    codexOauthPopupRef.current?.close();
    codexOauthPopupRef.current = null;
    codexOauthStateRef.current = null;
    setCodexOauthBusy(false);
    setCodexOauthAuthUrl("");
    setCodexOauthCallbackUrl("");
  }


  async function safeCopyText(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(successMessage);
    } catch (err) {
      showError(err);
    }
  }

  function isCodexCallbackUrlValid(value: string) {
    try {
      const url = new URL(value.trim());
      return !!url.searchParams.get("code") && !!url.searchParams.get("state");
    } catch {
      return false;
    }
  }

  const hasPreparedCodexOAuth = !!codexOauthStateRef.current && !!codexOauthAuthUrl;
  const codexCallbackReady = isCodexCallbackUrlValid(codexOauthCallbackUrl);
  const codexCallbackExample = "http://localhost:1455/auth/callback?code=...&state=...";
  const codexLoopbackUrl = "http://localhost:1455/auth/callback";

  async function startCodexOAuthSession() {
    const redirectUri = codexLoopbackUrl;
    const appPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
    const auth = await getCodexAuthorize(redirectUri);
    await startCodexOAuthProxy({
      appPort,
      state: auth.state,
      codeVerifier: auth.codeVerifier,
      redirectUri: auth.redirectUri,
    });
    codexOauthStateRef.current = auth.state;
    setCodexOauthAuthUrl(auth.authUrl);
    setCodexOauthCallbackUrl("");
    return auth;
  }

  function finishCodexOAuthSuccess(status: Awaited<ReturnType<typeof pollCodexOAuthStatus>>) {
    resetCodexOAuthFlow();
    showSuccess(`Codex connected: ${status.connection?.displayName || status.connection?.email || "account added"}`);
    setAddDialogProvider(null);
    load();
  }

  function beginCodexOAuthPolling() {
    clearCodexOAuthPolling();
    codexOauthPollRef.current = setInterval(async () => {
      const state = codexOauthStateRef.current;
      if (!state) return;

      try {
        const status = await pollCodexOAuthStatus(state);
        if (status.status === "done") {
          finishCodexOAuthSuccess(status);
          return;
        }

        if (status.status === "error" || status.status === "cancelled" || status.status === "not_found" || status.status === "unknown") {
          resetCodexOAuthFlow();
          showError(new Error(status.error || "Codex OAuth failed"));
        }
      } catch (pollError) {
        resetCodexOAuthFlow();
        showError(pollError);
      }
    }, 1500);
  }

  async function handleCodexOAuthLogin() {
    if (codexOauthBusy) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      const auth = await startCodexOAuthSession();
      codexOauthPopupRef.current = window.open(auth.authUrl, "codex_oauth_popup", "width=640,height=800");
      if (!codexOauthPopupRef.current) {
        window.open(auth.authUrl, "_blank", "noopener,noreferrer");
      }
      beginCodexOAuthPolling();
    } catch (err) {
      resetCodexOAuthFlow();
      showError(err);
    }
  }

  async function handleCodexOAuthPrepareManual() {
    if (codexOauthBusy || hasPreparedCodexOAuth) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      await startCodexOAuthSession();
      beginCodexOAuthPolling();
      setCodexOauthBusy(false);
      showSuccess("Auth URL ready. Open it, login, lalu paste callback URL di bawah.");
    } catch (err) {
      resetCodexOAuthFlow();
      showError(err);
    }
  }

  async function handleCodexOAuthSubmitManual() {
    if (codexOauthBusy || !codexCallbackReady) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      await completeCodexOAuthCallbackUrl(codexOauthCallbackUrl);
      const state = codexOauthStateRef.current;
      if (!state) {
        resetCodexOAuthFlow();
        showSuccess("Codex connected");
        setAddDialogProvider(null);
        await load();
        return;
      }
      const status = await pollCodexOAuthStatus(state);
      finishCodexOAuthSuccess(status);
    } catch (err) {
      setCodexOauthBusy(false);
      showError(err);
    }
  }

  async function handleCodexOAuthCopyAuthUrl() {
    if (!codexOauthAuthUrl) return;
    await safeCopyText(codexOauthAuthUrl, "Auth URL copied");
  }

  function handleCodexOAuthOpenManual() {
    if (!codexOauthAuthUrl) return;
    window.open(codexOauthAuthUrl, "_blank", "noopener,noreferrer");
  }

  async function handleCodexOAuthPasteCallback() {
    try {
      const text = await navigator.clipboard.readText();
      setCodexOauthCallbackUrl(text);
    } catch (err) {
      showError(err);
    }
  }

  function handleOpenAddDialog(provider: Provider) {
    resetCodexOAuthFlow();
    if (provider === "codex" || provider === "qoder") {
      setAddMode("pat");
    }
    setAddDialogProvider(provider);
  }

  function handleCloseAddDialog() {
    const state = codexOauthStateRef.current;
    resetCodexOAuthFlow();
    if (state) {
      stopCodexOAuth(state).catch(() => {});
    }
    setAddDialogProvider(null);
  }

  function handleSetCodexMode(mode: typeof addMode) {
    if (mode === addMode) return;
    const state = codexOauthStateRef.current;
    resetCodexOAuthFlow();
    if (state) {
      stopCodexOAuth(state).catch(() => {});
    }
    setAddMode(mode);
  }

  const BYOK_KEY_PLACEHOLDER = "••••••••";

  const emptyByokForm = () => ({
    label: "",
    base_url: "",
    api_key: "",
    format: "auto" as "openai" | "anthropic" | "auto",
    models: "",
    load_balancing_method: "round_robin" as "round_robin" | "sequential" | "least_inflight",
    keys: [{ label: "default", key: "", enabled: true }] as ByokFormKey[],
  });

  function byokSecretVisibilityId(key: ByokFormKey, index: number) {
    return key.id ? `id-${key.id}` : `new-${index}`;
  }

  async function toggleByokSecretVisibility(key: ByokFormKey, index: number) {
    const visibilityId = byokSecretVisibilityId(key, index);
    const isVisible = visibleByokSecrets.has(visibilityId);

    if (isVisible) {
      setVisibleByokSecrets((current) => {
        const next = new Set(current);
        next.delete(visibilityId);
        return next;
      });
      return;
    }

    if (key.id && key.key === BYOK_KEY_PLACEHOLDER) {
      setRevealingByokSecret(visibilityId);
      try {
        const revealed = await revealByokKey(key.id);
        updateByokKeyRow(index, { key: revealed.key });
      } catch (err) {
        showError(err);
        setRevealingByokSecret(null);
        return;
      }
      setRevealingByokSecret(null);
    }

    setVisibleByokSecrets((current) => {
      const next = new Set(current);
      next.add(visibilityId);
      return next;
    });
  }

  function addByokKeyRow() {
    setByokForm((form) => ({
      ...form,
      keys: [...form.keys, { label: `key-${form.keys.length + 1}`, key: "", enabled: true }],
    }));
  }

  function updateByokKeyRow(index: number, patch: Partial<ByokFormKey>) {
    setByokForm((form) => ({
      ...form,
      keys: form.keys.map((key, i) => i === index ? { ...key, ...patch } : key),
    }));
  }

  function removeByokKeyRow(index: number) {
    setByokForm((form) => ({
      ...form,
      keys: form.keys.length <= 1
        ? [{ label: "default", key: "", enabled: true }]
        : form.keys.filter((_, i) => i !== index),
    }));
  }

  function buildByokKeyPayload(isEdit: boolean) {
    return byokForm.keys.map((key, index) => ({
      id: key.id,
      label: key.label.trim().toLowerCase() || `key-${index + 1}`,
      key: key.key && key.key !== BYOK_KEY_PLACEHOLDER ? key.key.trim() : undefined,
      enabled: key.enabled,
      priority: index,
    })).filter((key) => isEdit || Boolean(key.key));
  }

  async function handleAddByok() {
    if (!byokForm.label || !byokForm.base_url || !byokForm.models) {
      showError(new Error("Provider name, base URL, and models are required"));
      return;
    }

    const models = byokForm.models.split(",").map(m => m.trim()).filter(Boolean);
    const apiKeys = buildByokKeyPayload(false);
    if (models.length === 0) {
      showError(new Error("At least one model is required"));
      return;
    }
    if (apiKeys.length === 0) {
      showError(new Error("Add at least one API key"));
      return;
    }

    try {
      const created = await createByokProvider({
        label: byokForm.label.trim().toLowerCase(),
        base_url: byokForm.base_url.trim(),
        api_keys: apiKeys,
        format: byokForm.format,
        load_balancing_method: byokForm.load_balancing_method,
        models,
      });
      showSuccess(`BYOK provider "${created.label}" created with ${created.key_count || apiKeys.length} key(s)`);
      setByokForm(emptyByokForm());
      setByokEditId(null);
      setByokDialogOpen(false);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  async function handleUpdateByok() {
    if (byokEditId === null) return;
    if (!byokForm.base_url || !byokForm.models) {
      showError(new Error("Base URL and models are required"));
      return;
    }

    const models = byokForm.models.split(",").map(m => m.trim()).filter(Boolean);
    const apiKeys = buildByokKeyPayload(true);
    if (models.length === 0) {
      showError(new Error("At least one model is required"));
      return;
    }
    if (apiKeys.length === 0) {
      showError(new Error("At least one key row is required"));
      return;
    }

    try {
      await updateByokProvider(byokEditId, {
        base_url: byokForm.base_url.trim(),
        format: byokForm.format,
        load_balancing_method: byokForm.load_balancing_method,
        models,
        api_keys: apiKeys,
      });
      showSuccess(`BYOK provider "${byokForm.label}" updated successfully`);
      setByokForm(emptyByokForm());
      setByokEditId(null);
      setByokDialogOpen(false);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  function copyByokModel(model: string) {
    navigator.clipboard?.writeText(model).then(() => {
      showSuccess(`Copied ${model}`);
    }).catch(() => showError(new Error("Clipboard not available")));
  }

  function handleEditByok(provider: ByokProvider) {
    setByokEditId(provider.id);
    setByokForm({
      label: provider.label,
      base_url: provider.base_url,
      api_key: BYOK_KEY_PLACEHOLDER,
      format: provider.format,
      models: provider.models.join(", "),
      load_balancing_method: provider.load_balancing_method || "round_robin",
      keys: (provider.keys && provider.keys.length > 0
        ? provider.keys.map((key, index) => ({
            id: key.id,
            label: key.label,
            key: BYOK_KEY_PLACEHOLDER,
            enabled: key.enabled !== false,
            status: key.status,
            errorMessage: key.errorMessage,
          }))
        : [{ id: provider.id, label: "default", key: BYOK_KEY_PLACEHOLDER, enabled: true }]) as ByokFormKey[],
    });
    setByokDialogOpen(true);
  }

  function handleCloseByokDialog() {
    setByokForm(emptyByokForm());
    setByokEditId(null);
    setByokDialogOpen(false);
  }

  async function handleTestByok(id: number, label: string) {
    try {
      const result = await testByokProvider(id);
      if (result.success) {
        const latency = result.latency_ms ? ` · ${result.latency_ms}ms` : "";
        const fixed = result.auto_fixed ? " — auto-fixed to active!" : "";
        showSuccess(`✓ ${label} OK (format: ${result.format}, model: ${result.model}${latency})${fixed}`);
        if (result.auto_fixed) await load();
      } else {
        showError(new Error(result.error || "Connection test failed"));
      }
    } catch (err) {
      showError(err);
    }
  }

  async function handleDeleteByok(id: number, label: string) {
    if (!confirm(`Delete BYOK provider "${label}"? This cannot be undone.`)) return;

    try {
      await deleteByokProvider(id);
      showSuccess(`BYOK provider "${label}" deleted`);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  const providerStats = useMemo(() => {
    return providers.map((provider) => {
      const rows = accounts.filter((a) => a.provider === provider);
      const quotaLimit = rows.reduce((sum, a) => sum + (a.quotaLimit || 0), 0);
      const quotaRemaining = rows.reduce((sum, a) => sum + (a.quotaRemaining || 0), 0);
      return {
        provider,
        total: rows.length,
        active: rows.filter((a) => a.status === "active").length,
        exhausted: rows.filter((a) => a.status === "exhausted").length,
        pending: rows.filter((a) => a.status === "pending").length,
        error: rows.filter((a) => a.status === "error").length,
        credits: { used: Math.max(0, quotaLimit - quotaRemaining), total: quotaLimit, remaining: quotaRemaining },
      };
    });
  }, [accounts]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Accounts</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">Manage provider accounts</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      {/* BYOK Providers Section */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">Custom Providers</h2>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">OpenAI or Anthropic-compatible endpoints</p>
          </div>
          <Button onClick={() => setByokDialogOpen(true)} className="w-full gap-2 sm:w-auto">
            <Plus className="h-4 w-4" /> Add Provider
          </Button>
        </div>

        {byokProviders.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {byokProviders.map((provider) => (
              <Card
                key={provider.id}
                className="cursor-pointer overflow-hidden border-[var(--border)] transition-[transform,border-color,box-shadow] duration-200 hover:border-[var(--primary)]/50"
                onClick={() => navigate(`/accounts/byok/${provider.label}`)}
              >
                <CardHeader className="pb-3 hover:bg-[var(--secondary)]/30 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-base truncate">{provider.label}</CardTitle>
                        <Badge
                          variant={(provider.active_key_count || 0) > 0 ? "default" : "secondary"}
                          className={(provider.active_key_count || 0) > 0
                            ? "bg-[var(--primary)]/15 text-[var(--primary)] border border-[var(--primary)]/30"
                            : "bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/30"
                          }
                        >
                          {(provider.active_key_count || 0) > 0 ? "● Ready" : "○ No active key"}
                        </Badge>
                      </div>
                      <p className="text-xs text-[var(--muted-foreground)] mt-1 truncate">{provider.base_url}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
                        <span className="rounded-full bg-[var(--secondary)] px-2 py-0.5">{provider.active_key_count ?? 0}/{provider.key_count ?? provider.keys?.length ?? 1} keys active</span>
                        <span className="rounded-full bg-[var(--secondary)] px-2 py-0.5">LB: {provider.load_balancing_method === "sequential" ? "Sequential" : provider.load_balancing_method === "least_inflight" ? "Least in-flight" : "Round robin"}</span>
                      </div>
                    </div>
                    <ChevronDown className="h-4 w-4 -rotate-90 text-[var(--muted-foreground)]" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--muted-foreground)]">Format</span>
                      <span className="text-[var(--foreground)] font-medium">{provider.format}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--muted-foreground)]">Models</span>
                      <span className="text-[var(--foreground)] font-medium">{provider.models.length}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--muted-foreground)]">API Keys</span>
                      <span className="text-[var(--foreground)] font-medium">{provider.active_key_count ?? 0} active / {provider.key_count ?? provider.keys?.length ?? 1} total</span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs text-[var(--muted-foreground)]">Available Models</p>
                    <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                      {provider.available_models?.slice(0, 10).map((model) => (
                        <Badge
                          key={model}
                          variant="outline"
                          className="text-xs border-[var(--primary)]/20 text-[var(--primary)]/80 bg-[var(--primary)]/[0.05] font-mono cursor-copy"
                          onClick={(e) => { e.stopPropagation(); copyByokModel(model); }}
                          title="Click to copy model id"
                        >
                          {model}
                        </Badge>
                      ))}
                      {provider.available_models && provider.available_models.length > 10 && (
                        <Badge variant="outline" className="text-xs bg-[var(--primary)]/10 text-[var(--primary)] border-[var(--primary)]/30 font-medium">
                          +{provider.available_models.length - 10} more
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[var(--border)]/50">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-[var(--foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                      onClick={(e) => { e.stopPropagation(); navigate(`/accounts/byok/${provider.label}`); }}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Manage
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-[var(--info)]/30 text-[var(--info)] hover:bg-[var(--info)]/10 hover:text-[var(--info)]"
                      onClick={(e) => { e.stopPropagation(); handleTestByok(provider.id, provider.label); }}
                    >
                      <Zap className="h-3.5 w-3.5" /> Test
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-[var(--error)]/30 text-[var(--error)] hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
                      onClick={(e) => { e.stopPropagation(); handleDeleteByok(provider.id, provider.label); }}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {byokProviders.length === 0 && (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--muted-foreground)]">
            <Key className="h-4 w-4" /> No custom providers — use Add Provider to connect an OpenAI/Anthropic-compatible endpoint
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">API Key Providers</h2>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">Codex and Qoder accounts managed by OmniArk</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {providerStats.map((stat) => (
            <Card key={stat.provider} className="cursor-pointer border-[var(--border)] transition-colors hover:border-[var(--primary)]/50 hover:bg-[var(--secondary)]/20" onClick={() => navigate(`/accounts/${stat.provider}`)}>
              <CardHeader className="pb-3"><div className="flex items-center justify-between"><div className="flex items-center gap-3"><ProviderMark provider={stat.provider} /><div><CardTitle className="text-base">{labelProvider(stat.provider)}</CardTitle><p className="mt-0.5 text-xs text-[var(--muted-foreground)]">API key provider</p></div></div><span className="text-xs text-[var(--muted-foreground)]">{stat.total}</span></div></CardHeader>
              <CardContent className="space-y-4"><div className="grid grid-cols-4 gap-2 text-center"><div className="rounded-md bg-[var(--secondary)] p-2"><p className="text-lg font-bold text-[var(--success)]">{stat.active}</p><p className="text-[10px] text-[var(--muted-foreground)]">Active</p></div><div className="rounded-md bg-[var(--secondary)] p-2"><p className="text-lg font-bold text-[var(--warning)]">{stat.exhausted}</p><p className="text-[10px] text-[var(--muted-foreground)]">Exhausted</p></div><div className="rounded-md bg-[var(--secondary)] p-2"><p className="text-lg font-bold text-[var(--warning)]">{stat.pending}</p><p className="text-[10px] text-[var(--muted-foreground)]">Pending</p></div><div className="rounded-md bg-[var(--secondary)] p-2"><p className="text-lg font-bold text-[var(--error)]">{stat.error}</p><p className="text-[10px] text-[var(--muted-foreground)]">Error</p></div></div><div className="space-y-1.5"><div className="flex justify-between text-xs"><span className="text-[var(--muted-foreground)]">Credits</span><span>{stat.credits.remaining.toFixed(1)} / {stat.credits.total.toFixed(1)} remaining</span></div><Progress value={stat.credits.total > 0 ? Math.round((stat.credits.remaining / stat.credits.total) * 100) : 0} className="h-2" /></div><div onClick={(event) => event.stopPropagation()}><Button className="w-full" size="sm" onClick={() => handleOpenAddDialog(stat.provider)}><Plus className="mr-1 h-4 w-4" /> Add</Button></div></CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* BYOK Add/Edit Dialog */}
      <Dialog open={byokDialogOpen} onOpenChange={(open) => !open && handleCloseByokDialog()}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
                <Key className="h-4.5 w-4.5" />
              </div>
              <div>
                <DTitle>{byokEditId ? 'Edit Custom Provider' : 'Add Custom Provider'}</DTitle>
                <DialogDescription className="mt-0.5">
                  {byokEditId ? 'Update your AI provider configuration' : 'Configure your own AI provider with your API key'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="space-y-4 pt-3">
            {/* Connection Settings */}
            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/[0.06] p-3.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Connection</p>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--foreground)]">Provider Name</label>
                <Input
                  value={byokForm.label}
                  onChange={(e) => setByokForm({ ...byokForm, label: e.target.value })}
                  placeholder="e.g., openrouter, myprovider"
                  readOnly={byokEditId !== null}
                  className={`focus:ring-1 focus:ring-[var(--ring)] ${byokEditId ? 'bg-[var(--muted)] opacity-60' : ''}`}
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                  {byokEditId ? 'Prefix cannot be changed after creation' : 'Used as model prefix (e.g., "openrouter-gpt-4")'}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--foreground)]">Base URL</label>
                <Input
                  value={byokForm.base_url}
                  onChange={(e) => setByokForm({ ...byokForm, base_url: e.target.value })}
                  placeholder="https://api.provider.com/v1"
                  className="focus:ring-1 focus:ring-[var(--ring)]"
                />
              </div>
            </div>

            {/* Authentication */}
            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/[0.06] p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">API Key Pool</p>
                </div>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={addByokKeyRow}>
                  <Plus className="h-3 w-3" /> Add Key
                </Button>
              </div>
              <p className="text-xs text-[var(--muted-foreground)]">
                Multiple keys under the same provider prefix are load-balanced automatically. Existing keys are masked; leave them masked to keep the stored secret.
              </p>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {byokForm.keys.map((keyRow, index) => (
                  <div key={`${keyRow.id || "new"}-${index}`} className="rounded-md border border-[var(--border)] bg-[var(--card)] p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={keyRow.label}
                        onChange={(e) => updateByokKeyRow(index, { label: e.target.value })}
                        placeholder="key label e.g. main"
                        className="h-8 flex-1 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => updateByokKeyRow(index, { enabled: !keyRow.enabled })}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${keyRow.enabled ? "bg-[var(--primary)]" : "bg-[var(--border)]"}`}
                        title={keyRow.enabled ? "Enabled" : "Disabled"}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${keyRow.enabled ? "translate-x-5" : "translate-x-1"}`} />
                      </button>
                      <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-[var(--error)]" onClick={() => removeByokKeyRow(index)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const visibilityId = byokSecretVisibilityId(keyRow, index);
                        const secretVisible = visibleByokSecrets.has(visibilityId);
                        return (
                          <div className="flex flex-1 items-center gap-1">
                            <Input
                              type={secretVisible ? "text" : "password"}
                              value={keyRow.key}
                              onChange={(e) => updateByokKeyRow(index, { key: e.target.value })}
                              onFocus={() => {
                                if (keyRow.key === BYOK_KEY_PLACEHOLDER) updateByokKeyRow(index, { key: "" });
                              }}
                              placeholder={byokEditId ? "Paste new key to replace, or keep masked" : "sk-..."}
                              className="h-8 flex-1 font-mono text-xs"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0"
                              onClick={() => toggleByokSecretVisibility(keyRow, index)}
                              disabled={revealingByokSecret === visibilityId}
                              title={secretVisible ? "Hide key" : "Show key"}
                            >
                              {revealingByokSecret === visibilityId ? <Loader2 className="h-4 w-4 animate-spin" /> : secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                          </div>
                        );
                      })()}
                      {keyRow.status && (
                        <Badge variant="outline" className={keyRow.status === "active" && keyRow.enabled ? "border-[var(--success)]/30 text-[var(--success)]" : "border-[var(--warning)]/30 text-[var(--warning)]"}>
                          {keyRow.enabled ? keyRow.status : "disabled"}
                        </Badge>
                      )}
                    </div>
                    {keyRow.errorMessage && <p className="text-[10px] text-[var(--error)] truncate">{keyRow.errorMessage}</p>}
                  </div>
                ))}
              </div>
            </div>

            {/* Model Configuration */}
            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/[0.06] p-3.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Configuration</p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-[var(--foreground)]">API Format</label>
                  <select
                    value={byokForm.format}
                    onChange={(e) => setByokForm({ ...byokForm, format: e.target.value as any })}
                    className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-[var(--foreground)]">Load Balancing</label>
                  <select
                    value={byokForm.load_balancing_method}
                    onChange={(e) => setByokForm({ ...byokForm, load_balancing_method: e.target.value as any })}
                    className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  >
                    <option value="round_robin">Round Robin</option>
                    <option value="sequential">Sequential</option>
                  </select>
                  <p className="text-[10px] text-[var(--muted-foreground)]">
                    Per-provider BYOK setting. Round Robin distributes requests; Sequential prefers the first healthy key.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--foreground)]">Models</label>
                <textarea
                  value={byokForm.models}
                  onChange={(e) => setByokForm({ ...byokForm, models: e.target.value })}
                  placeholder="gpt-4, claude-3-opus, llama-3"
                  className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                />
                <p className="text-xs text-[var(--muted-foreground)]">Comma-separated list of model IDs</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={handleCloseByokDialog} className="text-[var(--muted-foreground)]">
                Cancel
              </Button>
              <Button onClick={byokEditId ? handleUpdateByok : handleAddByok} className="gap-2 shadow-sm">
                {byokEditId ? (
                  <><Pencil className="h-4 w-4" /> Update Provider</>
                ) : (
                  <><Plus className="h-4 w-4" /> Add Provider</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Account Dialog (per-provider) */}
      <Dialog open={addDialogProvider !== null} onOpenChange={(open) => {
        if (open) return;
        handleCloseAddDialog();
      }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DTitle>Add {addDialogProvider ? labelProvider(addDialogProvider) : ""} Account</DTitle>
            <DialogDescription>
              {addDialogProvider === "codex"
                ? "Add via instant login with refresh token."
                : addDialogProvider === "qoder"
                ? "Add via Personal Access Token (PAT)."
                : `Add account for ${addDialogProvider ? labelProvider(addDialogProvider) : "this provider"}.`}
            </DialogDescription>
          </DialogHeader>

          {/* Mode tabs */}
          {addDialogProvider === "codex" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("instant")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "instant" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Instant Login (Token)</button>
              {addDialogProvider === "codex" && <button onClick={() => handleSetCodexMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >OAuth Login</button>}
            </div>
          ) : addDialogProvider === "qoder" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >PAT (Token)</button>
            </div>
          ) : null}

          {/* Token / OAuth mode */}
          {addMode === "pat" && addDialogProvider === "qoder" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Personal Access Token (PAT)</label>
                <textarea
                  value={cookieValue}
                  onChange={(e) => setCookieValue(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder="qd-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste Qoder Personal Access Token. Server akan menukar dengan jobToken otomatis dan menyimpan kredensial untuk inference.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleCookieLogin}>Add Account</Button>
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "codex" && (
            <div className="space-y-3">
              <div className="rounded-md border border-[var(--border)] bg-[var(--secondary)]/30 p-3 text-sm text-[var(--muted-foreground)]">
                Login Codex bisa via popup OpenAI atau mode manual: generate auth URL, buka, lalu paste callback URL.
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" size="sm" onClick={handleCodexOAuthPrepareManual} disabled={codexOauthBusy || hasPreparedCodexOAuth}>
                  {hasPreparedCodexOAuth ? "Manual Ready" : codexOauthBusy ? "Preparing..." : "Prepare Manual"}
                </Button>
                <Button size="sm" onClick={handleCodexOAuthLogin} disabled={codexOauthBusy || hasPreparedCodexOAuth}>
                  {codexOauthBusy ? "Waiting for OAuth..." : "Start OAuth Login"}
                </Button>
              </div>

              {hasPreparedCodexOAuth && (
                <div className="space-y-3 rounded-md border border-[var(--border)] p-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-sm text-[var(--foreground)]">Auth URL</label>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={handleCodexOAuthCopyAuthUrl}>Copy</Button>
                        <Button size="sm" variant="outline" onClick={handleCodexOAuthOpenManual}>Open</Button>
                      </div>
                    </div>
                    <textarea
                      value={codexOauthAuthUrl}
                      readOnly
                      className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-mono text-[var(--foreground)] focus:outline-none resize-none"
                    />
                  </div>

                  <div className="rounded-md bg-[var(--secondary)]/30 p-3 text-xs text-[var(--muted-foreground)] space-y-1.5">
                    <p><span className="text-[var(--foreground)]">Callback:</span> <code className="break-all">{codexLoopbackUrl}</code></p>
                    <p><span className="text-[var(--foreground)]">Contoh:</span> <code className="break-all">{codexCallbackExample}</code></p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-sm text-[var(--foreground)]">Callback URL</label>
                      <Button size="sm" variant="outline" onClick={handleCodexOAuthPasteCallback} disabled={codexOauthBusy}>Paste</Button>
                    </div>
                    <textarea
                      value={codexOauthCallbackUrl}
                      onChange={(e) => setCodexOauthCallbackUrl(e.target.value)}
                      className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                      placeholder={codexCallbackExample}
                    />
                    <div className="flex justify-end">
                      <Button size="sm" onClick={handleCodexOAuthSubmitManual} disabled={codexOauthBusy || !codexCallbackReady}>
                        {codexOauthBusy ? "Completing OAuth..." : "Submit Callback URL"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={handleCloseAddDialog} disabled={codexOauthBusy && !hasPreparedCodexOAuth}>Cancel</Button>
              </div>
            </div>
          )}

          {addMode === "instant" && addDialogProvider === "codex" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Refresh Tokens (satu per baris)</label>
                <textarea
                  value={instantTokens}
                  onChange={(e) => setInstantTokens(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={"eyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs..."}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste refresh token per baris. Email otomatis di-extract dari token.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleInstantLogin}>Login Instant</Button>
              </div>
            </div>
          )}

          {/* No manual add flow exists for this provider */}
          {addDialogProvider !== null && !["codex", "qoder"].includes(addDialogProvider) && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-4 text-sm text-[var(--muted-foreground)]">
              {labelProvider(addDialogProvider)} accounts can't be added manually — use a Codex token or OAuth login, or a Qoder PAT.
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderMark({ provider }: { provider: string }) {
  const isCodex = provider === "codex";
  return (
    <span className={`grid h-9 w-9 place-items-center rounded-lg font-mono text-xs font-bold ${isCodex ? "bg-[var(--chart-1)]/15 text-[var(--chart-1)]" : "bg-[var(--chart-4)]/15 text-[var(--chart-4)]"}`}>
      {isCodex ? "C" : "Q"}
    </span>
  );
}
