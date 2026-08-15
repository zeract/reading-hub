import { describe, expect, it } from "vitest";
import { GenericConnector } from "../src/main/connectors";
import type { Source } from "../src/shared/types";

describe("GenericConnector", () => {
  it("performs one unconditional refresh for a legacy automatic rule, then stamps its repair revision", async () => {
    let receivedOptions: unknown = "not-called";
    const http = {
      getText: async (_url: string, options: unknown) => {
        receivedOptions = options;
        return {
          url: "https://example.com/",
          text: `<main><ul><li>16 Jul 2026 <a href="/one">A sufficiently descriptive first post</a></li><li>15 Jul 2026 <a href="/two">A sufficiently descriptive second post</a></li></ul></main>`,
          status: 200
        };
      }
    };
    const source: Source = {
      id: "source", url: "https://example.com/", title: "Example", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      etag: "old-etag", lastModified: "Fri, 17 Jul 2026 12:20:57 GMT",
      extractionRule: { version: 1, itemRootSelector: "li" }
    };
    const connector = new GenericConnector(http as any, {} as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(receivedOptions).toBeUndefined();
    expect(outcome.entries).toHaveLength(2);
    expect(outcome.extractionRule?.autoRepairRevision).toBeDefined();
  });
});
