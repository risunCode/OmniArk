import type { BaseProvider, ModelInfo } from "./base";
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
 * disambiguating overlapping patterns: more specific providers come first.
 */
const codex = new CodexProvider();
const qoder = new QoderProvider();
const byok = new ByokProvider();

// Priority order. qoder/codex have unique prefixes; byok checks dynamic prefixes
// from DB accounts.
const PROVIDER_ORDER = [qoder, codex, byok] as const;

export const providers = {
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
  return null;
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
