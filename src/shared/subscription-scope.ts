import type { Facet, FacetReference, SubscriptionScope } from "./types";

const MAX_FACET_SCHEME_LENGTH = 320;
const MAX_FACET_KEY_LENGTH = 500;
const MAX_FACET_LABEL_LENGTH = 240;
const MAX_FACETS_PER_RECORD = 64;
const MAX_HISTORY_LIMIT = 10_000;

/** Return a fresh scope so callers can safely update it without shared state. */
export function defaultSubscriptionScope(): SubscriptionScope {
  return { facetSelections: [], history: { mode: "none" } };
}

/**
 * Normalise connector-supplied metadata at the shared boundary. Invalid or
 * over-large labels are ignored rather than letting one publisher tag block a
 * whole synchronisation run. A label is display data; the scheme/key pair is
 * the durable identity.
 */
export function normaliseFacet(value: unknown): Facet | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.scheme !== "string" || typeof record.key !== "string" || typeof record.label !== "string") return undefined;
  const scheme = record.scheme.trim();
  const key = record.key.trim();
  const label = record.label.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!scheme || !key || !label) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(scheme) || /[\u0000-\u001F\u007F]/.test(key)) return undefined;
  if (scheme.length > MAX_FACET_SCHEME_LENGTH || key.length > MAX_FACET_KEY_LENGTH || label.length > MAX_FACET_LABEL_LENGTH) return undefined;
  return { scheme, key, label };
}

/** Normalise an identity-only facet reference used by library queries. */
export function normaliseFacetReference(value: unknown): FacetReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.scheme !== "string" || typeof record.key !== "string") return undefined;
  const scheme = record.scheme.trim();
  const key = record.key.trim();
  if (!scheme || !key || scheme.length > MAX_FACET_SCHEME_LENGTH || key.length > MAX_FACET_KEY_LENGTH) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(scheme) || /[\u0000-\u001F\u007F]/.test(key)) return undefined;
  return { scheme, key };
}

/** Deduplicate facets by their durable scheme/key identity. */
export function normaliseFacets(values: readonly Facet[] | undefined): Facet[] {
  if (!values?.length) return [];
  const unique = new Map<string, Facet>();
  for (const value of values) {
    const facet = normaliseFacet(value);
    if (!facet) continue;
    const identity = facetIdentity(facet);
    // Keep the first label. Connectors should already emit one consistent
    // label per ID, and retaining it makes a malformed duplicate harmless.
    if (!unique.has(identity)) unique.set(identity, facet);
    if (unique.size >= MAX_FACETS_PER_RECORD) break;
  }
  return [...unique.values()];
}

/**
 * Resolve legacy or partial data to the conservative Feed-only default.
 * The returned object is always a new, serialisable value.
 */
export function normaliseSubscriptionScope(value: SubscriptionScope | undefined): SubscriptionScope {
  const facets = normaliseFacets(value?.facetSelections);
  const mode = value?.history?.mode;
  const validMode = mode === "selected" || mode === "all" ? mode : "none";
  const rawLimit = value?.history?.limit;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_HISTORY_LIMIT
    ? rawLimit
    : undefined;
  return {
    facetSelections: facets,
    history: {
      mode: validMode,
      ...(validMode === "none" || limit === undefined ? {} : { limit })
    }
  };
}

/** Labels and OR-selection order are presentation; history and facet IDs
 * determine which records a connector may collect. */
export function sameSubscriptionScope(left: SubscriptionScope | undefined, right: SubscriptionScope | undefined): boolean {
  return JSON.stringify(normaliseSubscriptionScope(left).history) === JSON.stringify(normaliseSubscriptionScope(right).history)
    && sameFacetSelections(left?.facetSelections, right?.facetSelections);
}

/** Current collection filters do not depend on history limits or display labels. */
export function sameFacetSelections(left: readonly Facet[] | undefined, right: readonly Facet[] | undefined): boolean {
  const identity = (facets: readonly Facet[] | undefined) => JSON.stringify(normaliseFacets(facets).map(facetIdentity).sort());
  return identity(left) === identity(right);
}

/** Compile one immutable selection per batch. Current Feed entries pass with
 * no selection; explicit selected-history callers must reject an empty scope
 * before acquisition. Matching always uses publisher-scoped IDs, not labels. */
export function createSubscriptionScopeMatcher(scope: SubscriptionScope | undefined): (entry: { facets?: readonly Facet[] }) => boolean {
  const selections = normaliseSubscriptionScope(scope).facetSelections;
  if (!selections.length) return () => true;
  const selectedIds = new Set(selections.map(facetIdentity));
  return (entry) => normaliseFacets(entry.facets).some((facet) => selectedIds.has(facetIdentity(facet)));
}

export function facetIdentity(facet: Pick<Facet, "scheme" | "key">): string {
  return `${facet.scheme}\u0000${facet.key}`;
}
