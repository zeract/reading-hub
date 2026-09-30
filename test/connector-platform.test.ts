import { afterEach, describe, expect, it, vi } from "vitest";
import { AcademicAuthorConnector } from "../src/main/academic";
import { builtInManifest, ConnectorRegistry } from "../src/main/connector-registry";
import { identityContentHash } from "../src/main/content-hash";
import type { Source } from "../src/shared/types";

const academicSource: Source = {
  id: "academic-source", url: "https://academic.local/author/test", title: "Researcher", kind: "academic", connectorId: "academic",
  status: "active", pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
};

describe("connector platform", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only accepts explicitly built-in adapters", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.register({
      manifest: { ...builtInManifest("academic", "Test"), builtIn: false },
      sync: async () => ({ entries: [] }),
      normalize: () => { throw new Error("unused"); }
    } as any)).toThrow("只允许注册内置连接器");
  });

  it("rejects unknown identity authorities instead of treating a prefix as a contract", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.register({
      manifest: { ...builtInManifest("academic", "Test"), identityNamespaces: ["email"] },
      sync: async () => ({ entries: [] }),
      normalize: () => { throw new Error("unused"); }
    } as any)).toThrow("未知的内容身份命名空间");
  });

  it("does not let another built-in adapter claim a provider-owned identity", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.register({
      manifest: { ...builtInManifest("mirror", "Mirror"), identityNamespaces: ["openalex"] },
      sync: async () => ({ entries: [] }),
      normalize: () => { throw new Error("unused"); }
    } as any)).toThrow("其他提供方拥有的内容身份命名空间");
  });

  it("normalizes academic DOI records to stable cross-provider content identity", () => {
    const connector = new AcademicAuthorConnector();
    const entry = connector.normalize({
      url: "https://doi.org/10.1000/example",
      title: "Paper",
      canonicalIdentity: "doi:10.1000/example",
      externalId: "openalex:work",
      providerId: "academic",
      providerLabel: "OpenAlex"
    }, academicSource);
    expect(entry).toMatchObject({
      canonicalUrl: "https://doi.org/10.1000/example",
      canonicalIdentity: "doi:10.1000/example",
      providerLabel: "OpenAlex",
      providerId: "academic"
    });

    const doiFallback = connector.normalize({
      url: "https://doi.org/10.1000/example",
      title: "Paper"
    }, academicSource);
    expect(doiFallback).toMatchObject({
      canonicalUrl: "https://doi.org/10.1000/example",
      canonicalIdentity: "doi:10.1000/example",
      providerId: "academic"
    });
    expect(doiFallback.contentHash).toBe(identityContentHash("doi:10.1000/example", { title: "Paper" }));
  });

  it("queries academic providers through their documented API roots", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.includes("api.openalex.org")) return new Response(JSON.stringify({ results: [{ id: "https://openalex.org/W1", doi: "https://doi.org/10.1000/example", title: "OpenAlex paper", publication_date: "2026-08-15" }] }), { status: 200 });
      if (url.includes("semanticscholar")) return new Response(JSON.stringify({ data: [{ paperId: "S1", title: "Semantic paper", publicationDate: "2026-08-14", externalIds: { DOI: "10.1000/example" } }] }), { status: 200 });
      return new Response(JSON.stringify({ group: [] }), { status: 200 });
    });
    const connector = new AcademicAuthorConnector(fetchMock);
    const result = await connector.sync({
      source: academicSource,
      subscription: {
        id: "subscription", sourceId: academicSource.id, connectorId: "academic", config: {
          authorName: "Researcher", openAlexId: "A1", semanticScholarId: "S1", orcid: "0000-0002-1825-0097"
        }, createdAt: 1, updatedAt: 1
      }
    });
    expect(result.entries).toHaveLength(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining("https://api.openalex.org/works"),
      expect.stringContaining("https://api.semanticscholar.org/graph/v1/author/S1/papers"),
      expect.stringContaining("https://pub.orcid.org/v3.0/0000-0002-1825-0097/works")
    ]));
  });
});
