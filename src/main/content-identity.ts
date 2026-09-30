import { CONTENT_IDENTITY_NAMESPACES, type ContentIdentityNamespace } from "../shared/types";

/** A namespaced key is authoritative only when its built-in connector declares it. */
export function isAuthorizedContentIdentity(identity: string, namespaces: readonly ContentIdentityNamespace[] | undefined): boolean {
  if (!namespaces?.length) return false;
  const separator = identity.indexOf(":");
  if (separator < 1) return false;
  const namespace = identity.slice(0, separator);
  const value = identity.slice(separator + 1);
  return namespaces.some((declared) => declared === namespace)
    && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

export function isRegisteredContentIdentity(identity: string): boolean {
  return isAuthorizedContentIdentity(identity, CONTENT_IDENTITY_NAMESPACES);
}

/** URL-derived identities can be stored, but cannot bridge different URLs. */
export function isUrlDerivedContentIdentity(identity: string): boolean {
  try {
    const candidate = identity.startsWith("url:") ? identity.slice(4) : identity;
    return ["http:", "https:"].includes(new URL(candidate).protocol);
  } catch {
    return false;
  }
}

/** Both historic URL forms refer to the same already-matched card address. */
export function isIdentityForCanonicalUrl(identity: string, canonicalUrl: string): boolean {
  return identity === canonicalUrl || identity === `url:${canonicalUrl}`;
}
