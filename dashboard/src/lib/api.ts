function resolveApiBase(): string {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  return window.location.origin;
}

export const API_BASE = resolveApiBase();

export function getWsBase(): string {
  const configured = import.meta.env.VITE_WS_BASE;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}`;
}

function getApiKey(): string {
  return localStorage.getItem("api_key") || "pool-proxy-secret-key";
}

export async function validateApiKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/keys/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.valid === true;
  } catch {
    return false;
  }
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem("api_key");
}

export function logout() {
  localStorage.removeItem("api_key");
}

type FetchApiOptions = RequestInit & { timeoutMs?: number };

export async function fetchApi<T = any>(path: string, options?: FetchApiOptions): Promise<T> {
  const { timeoutMs = 30_000, signal, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const abortOnSignal = () => controller.abort(signal?.reason);
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abortOnSignal, { once: true });
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getApiKey()}`,
        ...fetchOptions.headers,
      },
    });

    if (!res.ok) {
      let message = `API error: ${res.status}`;
      try {
        const body = await res.json();
        message = body.error || body.message || message;
      } catch {
        const text = await res.text().catch(() => "");
        if (text) message = text;
      }
      throw new Error(message);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? JSON.parse(text) : (undefined as T);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abortOnSignal);
  }
}

export function clampLimit(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPollingLoop(fn: () => Promise<void>, intervalMs: number, signal: AbortSignal) {
  while (!signal.aborted) {
    await fn().catch(() => {});
    await Promise.race([
      sleep(intervalMs),
      new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ]);
  }
}

export async function fetchDashboardStats(hours?: number | null, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null && hours !== undefined) params.set("hours", String(hours));
  if (range) params.set("range", range);
  const qs = params.toString();
  return fetchApi(`/api/stats${qs ? `?${qs}` : ""}`);
}

export async function fetchAccounts() {
  return fetchApi("/api/accounts");
}

export async function fetchProviders() {
  return fetchApi("/api/stats/providers");
}

export async function fetchAvailableProviders(): Promise<{ data: string[] }> {
  return fetchApi("/api/providers");
}

export async function fetchUsage(hours: number | null = 24, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null) params.set("hours", String(hours));
  if (range) params.set("range", range);
  params.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return fetchApi(`/api/stats/usage?${params.toString()}`);
}

export async function fetchModelUsage(hours?: number | null, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null && hours !== undefined) params.set("hours", String(hours));
  if (range) params.set("range", range);
  const qs = params.toString();
  return fetchApi(`/api/stats/models${qs ? `?${qs}` : ""}`);
}

export async function refreshAccountQuota(accountId: number) {
  return fetchApi(`/api/accounts/${accountId}/refresh-quota`, {
    method: "POST",
  });
}

export async function fetchRequests(page: number = 1, limit: number = 50, provider?: string) {
  const safeLimit = clampLimit(limit, 50, 1, 500);
  const safePage = clampLimit(page, 1, 1, 1000);
  const offset = (safePage - 1) * safeLimit;
  const params = new URLSearchParams({ limit: String(safeLimit), offset: String(offset) });
  if (provider && provider !== "all") params.set("provider", provider);
  return fetchApi(`/api/stats/requests?${params.toString()}`);
}

/**
 * Fetch full detail (including heavy requestBody / responseBody) for a single
 * request log. Used by the Requests page detail drawer so the list endpoint
 * can stay lightweight.
 */
export async function fetchRequestDetail(id: number) {
  return fetchApi<{ data: unknown }>(`/api/stats/requests/${id}`);
}

export async function fetchModels() {
  return fetchApi("/v1/models");
}

export async function testUpstreamModel(model: string): Promise<{
  success: boolean;
  model: string;
  provider?: string;
  account?: string;
  latencyMs?: number;
  response?: string;
  error?: string;
}> {
  return fetchApi(`/api/models/${encodeURIComponent(model)}/test`, { method: "POST", timeoutMs: 90_000 });
}

export interface ModelMappingDTO {
  id?: number;
  sourcePattern: string;
  matchType: string;
  targetModel: string;
  enabled: boolean;
  priority: number;
  label?: string | null;
}

export interface IntegrationData {
  enabled: boolean;
  mappings: ModelMappingDTO[];
  models?: { id: string; owned_by: string }[];
}

export async function fetchIntegration(): Promise<IntegrationData> {
  return fetchApi("/api/integration");
}

export async function saveIntegration(payload: { enabled?: boolean; mappings?: ModelMappingDTO[] }) {
  return fetchApi("/api/integration", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export interface ApplyConfigResult {
  success: boolean;
  path: string;
  config: Record<string, unknown>;
}

export async function applyIntegrationConfig(baseUrl: string): Promise<ApplyConfigResult> {
  return fetchApi("/api/integration/apply-config", {
    method: "POST",
    body: JSON.stringify({ baseUrl }),
  });
}

// ── Multi-Client Integration ─────────────────────────────────────

export interface ClientMetaDTO {
  id: string;
  name: string;
  description: string;
  cli: string;
  url: string;
  detected: boolean;
  configPaths: string[];
}

export interface IntegrationModelDTO {
  id: string;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
}

export interface IntegrationClientsData {
  clients: ClientMetaDTO[];
  models: IntegrationModelDTO[];
}

export interface ClientConfigPreviewDTO {
  client: string;
  success: boolean;
  preview?: Record<string, unknown>;
  paths: string[];
  backupPaths: string[];
  error?: string;
}

export interface ApplyClientResult {
  client: string;
  success: boolean;
  paths: string[];
  backupPaths: string[];
  error?: string;
}

export interface ApplyAllResult {
  success: boolean;
  results: ApplyClientResult[];
}

export async function fetchIntegrationClients(): Promise<IntegrationClientsData> {
  return fetchApi("/api/integration/clients");
}

export async function fetchClientConfigPreview(
  clientId: string,
  baseUrl: string,
  modelId?: string
): Promise<ClientConfigPreviewDTO> {
  return fetchApi(`/api/integration/clients/${clientId}/preview`, {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId }),
  });
}

export async function applyClientConfig(
  clientId: string,
  baseUrl: string,
  modelId?: string
): Promise<ApplyClientResult> {
  return fetchApi(`/api/integration/clients/${clientId}/apply`, {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId }),
  });
}

export async function applyAllClients(
  baseUrl: string,
  modelId?: string
): Promise<ApplyAllResult> {
  return fetchApi("/api/integration/apply-all", {
    method: "POST",
    body: JSON.stringify({ baseUrl, modelId }),
  });
}

export async function restoreClientConfig(
  clientId: string
): Promise<{ success: boolean; path?: string; restoredFrom?: string; error?: string }> {
  return fetchApi(`/api/integration/clients/${clientId}/restore`, {
    method: "POST",
  });
}

export async function fetchSettings() {
  return fetchApi("/api/settings");
}

export async function updateSettings(settings: Record<string, string>) {
  return fetchApi("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function fetchProviderList(): Promise<{ data: string[] }> {
  return fetchApi("/api/settings/providers");
}

export async function deleteAccount(id: number) {
  return fetchApi(`/api/accounts/${id}`, { method: "DELETE" });
}

export async function bulkDeleteAccounts(ids: number[]): Promise<{
  success: boolean;
  requested: number;
  deleted: number;
  deletedIds: number[];
  providers: string[];
  notFound: number[];
}> {
  return fetchApi("/api/accounts/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function toggleAccountEnabled(id: number, enabled?: boolean) {
  return fetchApi<{ id: number; enabled: boolean; status: string; provider: string }>(
    `/api/accounts/${id}/toggle`,
    {
      method: "POST",
      body: JSON.stringify(typeof enabled === "boolean" ? { enabled } : {}),
    },
  );
}

export async function toggleAllAccounts(provider: string, enabled: boolean) {
  return fetchApi<{ provider: string; enabled: boolean; count: number }>(
    "/api/accounts/toggle-all",
    {
      method: "POST",
      body: JSON.stringify({ provider, enabled }),
    },
  );
}

export async function fetchApiKey() {
  return fetchApi("/api/keys");
}

export async function regenerateApiKey() {
  return fetchApi("/api/keys/regenerate", { method: "POST" });
}

export async function setApiKey(key: string) {
  return fetchApi("/api/keys/set", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

export async function testApiKey(key: string) {
  return fetchApi("/api/keys/test", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

// Proxy Pool
export async function fetchProxyPool() {
  return fetchApi("/api/proxy-pool/pool");
}

export async function addProxies(proxies: string[]) {
  return fetchApi("/api/proxy-pool/pool", {
    method: "POST",
    body: JSON.stringify({ proxies }),
  });
}

export async function updateProxy(id: number, data: { status?: string; label?: string }) {
  return fetchApi(`/api/proxy-pool/pool/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteProxy(id: number) {
  return fetchApi(`/api/proxy-pool/pool/${id}`, { method: "DELETE" });
}

export async function clearProxyPool() {
  return fetchApi("/api/proxy-pool/pool", { method: "DELETE" });
}

export async function checkProxy(id: number) {
  return fetchApi(`/api/proxy-pool/pool/${id}/check`, { method: "POST" });
}

export async function checkAllProxies() {
  return fetchApi("/api/proxy-pool/pool/check-all", { method: "POST" });
}

export interface ManagedApiKey {
  id: number;
  name: string;
  keyPrefix: string;
  modelAllowlist: string[];
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  dailyTokens: number;
  monthlyTokens: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ApiKeyPolicyInput {
  name: string;
  key?: string;
  modelAllowlist: string[];
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  expiresAt: string | null;
}

export async function fetchCustomApiKeys(): Promise<{ data: ManagedApiKey[] }> {
  return fetchApi("/api/keys/custom");
}

export async function createCustomApiKey(data: ApiKeyPolicyInput): Promise<{ data: ManagedApiKey; key: string }> {
  return fetchApi("/api/keys/custom", { method: "POST", body: JSON.stringify(data) });
}

export async function updateCustomApiKey(id: number, data: ApiKeyPolicyInput): Promise<{ data: ManagedApiKey }> {
  return fetchApi(`/api/keys/custom/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export async function rotateCustomApiKey(id: number): Promise<{ data: ManagedApiKey; key: string }> {
  return fetchApi(`/api/keys/custom/${id}/rotate`, { method: "POST" });
}

export async function deleteCustomApiKey(id: number): Promise<void> {
  return fetchApi(`/api/keys/custom/${id}`, { method: "DELETE" });
}

export interface CodexAuthorizeResponse {
  authUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  flowType: string;
  fixedPort: number;
  callbackPath: string;
}

export interface CodexOAuthStatusResponse {
  status: string;
  error?: string;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    workspace?: string | null;
    plan?: string | null;
  };
}

export async function getCodexAuthorize(redirectUri: string): Promise<CodexAuthorizeResponse> {
  return fetchApi(`/api/oauth/codex/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
}

export async function startCodexOAuthProxy(input: {
  appPort: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const params = new URLSearchParams({
    app_port: input.appPort,
    state: input.state,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });
  return fetchApi(`/api/oauth/codex/start-proxy?${params.toString()}`);
}

export async function pollCodexOAuthStatus(state: string): Promise<CodexOAuthStatusResponse> {
  return fetchApi(`/api/oauth/codex/poll-status?state=${encodeURIComponent(state)}`);
}

export async function stopCodexOAuth(state?: string) {
  const suffix = state ? `?state=${encodeURIComponent(state)}` : "";
  return fetchApi(`/api/oauth/codex/stop-proxy${suffix}`);
}

export async function completeCodexOAuth(input: { code: string; state: string }) {
  return fetchApi<{ success: boolean; connection?: CodexOAuthStatusResponse["connection"] }>("/api/oauth/codex/complete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function completeCodexOAuthCallbackUrl(callbackUrl: string) {
  const url = new URL(callbackUrl.trim());
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || error;

  if (error) {
    throw new Error(errorDescription || error);
  }

  if (!code || !state) {
    throw new Error("Callback URL must include code and state");
  }

  return completeCodexOAuth({ code, state });
}

// BYOK (Bring Your Own Key) API functions
export interface ByokKeyInfo {
  id?: number;
  label: string;
  key?: string;
  status?: string;
  enabled?: boolean;
  weight?: number;
  priority?: number;
  lastUsedAt?: string | null;
  errorMessage?: string | null;
}

export interface ByokProvider {
  id: number;
  label: string;
  base_url: string;
  format: "openai" | "anthropic" | "auto";
  models: string[];
  model_prefix: string;
  headers?: Record<string, string>;
  status: string;
  enabled: boolean;
  available_models?: string[];
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  key_count?: number;
  active_key_count?: number;
  keys?: ByokKeyInfo[];
}

export async function fetchByokProviders(): Promise<{ providers: ByokProvider[] }> {
  return fetchApi("/api/accounts/byok");
}

export async function createByokProvider(data: {
  label: string;
  base_url: string;
  api_key?: string;
  api_keys?: ByokKeyInfo[];
  format?: "openai" | "anthropic" | "auto";
  models: string[];
  headers?: Record<string, string>;
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
}): Promise<{ success: boolean; id: number; label: string; models: string[]; key_count?: number }> {
  return fetchApi("/api/accounts/byok", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateByokProvider(
  id: number,
  data: {
    base_url?: string;
    api_key?: string;
    api_keys?: ByokKeyInfo[];
    format?: "openai" | "anthropic" | "auto";
    models?: string[];
    headers?: Record<string, string>;
    load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  }
): Promise<{ success: boolean; id: number; label: string; models: string[] }> {
  return fetchApi(`/api/accounts/byok/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteByokProvider(id: number): Promise<{ success: boolean; deleted: number }> {
  return fetchApi(`/api/accounts/byok/${id}`, { method: "DELETE" });
}

export async function revealByokKey(
  id: number
): Promise<{ success: boolean; id: number; label: string; key: string }> {
  return fetchApi(`/api/accounts/byok/${id}/reveal`, { method: "POST" });
}

export async function testByokProvider(
  id: number,
  model?: string
): Promise<{
  success: boolean;
  error?: string;
  warning?: string;
  model?: string;
  format?: string;
  latency_ms?: number;
  auto_fixed?: boolean;
}> {
  return fetchApi(`/api/accounts/byok/${id}/test`, {
    method: "POST",
    body: JSON.stringify(model ? { model } : {})
  });
}
