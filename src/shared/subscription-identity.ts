import type { Source } from "./types";
/** Subscription identity preserves requested paths/query; Feed fragments are not sent over HTTP. */
export function subscriptionUrlIdentity(source: Pick<Source, "url" | "kind">): string {
    const url = new URL(source.url);
    if (source.kind === "rss")
        url.hash = "";
    return url.toString();
}
