import type { BaseProvider, ModelInfo } from "./base";
import { KiroProvider } from "./kiro/index";
import { CodexProvider } from "./codex/index";
import { QoderProvider } from "./qoder/index";
import { ByokProvider } from "./byok";

/**
 * Single source of truth for the provider set.
 *
 * To add / remove / change a provider you touch exactly two things:
 *   1. that provider's own file (its models + ownsModel() pattern), and
 *   2. one line in PROVIDER_ORDER below.
 *
 * Routing (getProviderForModel) and model listing (getAllModels) iterate this
 * list — there is no per-provider logic anywhere else. Order matters only for
 * disambiguating overlapping patterns: more specific providers come first, and
 * the single isFallback provider (kiro standard) is consulted last.
 */
// kiro and kiro-pro are two variants of the SAME provider class — same upstream
// (AWS CodeWhisperer), different model catalog + account pool. They keep
// distinct provider names so DB/dashboard treat them separately.
const kiro = new KiroProvider({ variant: "standard" });
const kiroPro = new KiroProvider({ variant: "pro" });
const codex = new CodexProvider();
const qoder = new QoderProvider();
const byok = new ByokProvider();

// Priority order. qoder/codex/kiro-pro have unique prefixes; byok checks dynamic
// prefixes from DB accounts. kiro is the fallback.
const PROVIDER_ORDER = [qoder, codex, kiroPro, byok, kiro] as const;

export const providers = {
  kiro,
  "kiro-pro": kiroPro,
  codex,
  qoder,
  byok,
} as const;

export type ProviderName = keyof typeof providers;

/** Map a model id to the provider that handles it. */
export function getProviderForModel(model: string): ProviderName | null {
  for (const provider of PROVIDER_ORDER) {
    if (provider.ownsModel(model)) return provider.name as ProviderName;
  }
  const fallback = PROVIDER_ORDER.find((p) => p.isFallback);
  return (fallback?.name as ProviderName) ?? null;
}

/** All models across every registered provider. */
export function getAllModels(): ModelInfo[] {
  return PROVIDER_ORDER.flatMap((provider) => provider.getModels());
}

/** Iterable list of provider instances (priority order). */
export const providerList: readonly BaseProvider[] = PROVIDER_ORDER;

/** Refresh BYOK models from database. */
export async function refreshByokModels(): Promise<void> {
  await byok.refreshModelsCache();
}

/** Get BYOK provider instance. */
export function getByokProvider(): ByokProvider {
  return byok;
}
