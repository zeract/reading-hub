import { describe, expect, it, vi } from "vitest";
import { AcademicAuthorConnector } from "../src/main/academic";

const json = (value: unknown) => new Response(JSON.stringify(value));
const orcid = "0000-0002-1825-0097";
function connector(openAlex: unknown[], semantic: unknown[]) {
  return new AcademicAuthorConnector(async (url) => url.includes("openalex.org") ? json({ results: openAlex }) : json({ data: semantic }));
}

describe("academic author discovery", () => {
  it("keeps same-name authors separate within and across providers", async () => {
    const authors = await connector([
      { id: "https://openalex.org/A1", display_name: "Alex Chen", works_count: 12 },
      { id: "https://openalex.org/A2", display_name: "Alex Chen", works_count: 34 }
    ], [{ authorId: "3", name: "Alex Chen", paperCount: 56 }]).discover("Alex Chen");
    expect(authors.map((author) => author.targetId)).toEqual(["openalex:A1", "openalex:A2", "semantic:3"]);
    expect(authors.map((author) => author.config)).toMatchObject([
      { openAlexId: "A1" }, { openAlexId: "A2" }, { semanticScholarId: "3" }
    ]);
    expect(new Set(authors.map((author) => author.title)).size).toBe(3);
  });

  it("preserves conflicting provider identities even when their ORCID matches", async () => {
    const authors = await connector([
      { id: "A1", display_name: "Alex Chen", orcid },
      { id: "A2", display_name: "Alex Chen", orcid }
    ], [{ authorId: "3", name: "Alex Chen", externalIds: { ORCID: orcid } }]).discover("Alex Chen");
    expect(authors).toHaveLength(3);
    expect(authors.map((author) => author.targetId)).toEqual(["openalex:A1", "openalex:A2", "semantic:3"]);
  });

  it("reports unavailable search instead of claiming there are no authors", async () => {
    const search = new AcademicAuthorConnector(async () => new Response("{}", { status: 503 }));
    await expect(search.discover("Alex Chen")).rejects.toThrow("503");
  });

  it("does not report an empty search if only the failing provider could have returned matches", async () => {
    const search = new AcademicAuthorConnector(async (url) => url.includes("openalex.org") ? json({ results: [] }) : new Response("{}", { status: 429 }));
    await expect(search.discover("Alex Chen")).rejects.toThrow("429");
  });

  it.each([orcid, "0000-0002-1694-233X"])("merges cross-provider records with a valid shared ORCID %s", async (id) => {
    const authors = await connector([
      { id: "A1", display_name: "Alex Chen", orcid: `https://orcid.org/${id.toLowerCase()}` }
    ], [{ authorId: "3", name: "A. Chen", externalIds: { ORCID: id } }]).discover("Chen");
    expect(authors).toHaveLength(1);
    expect(authors[0]).toMatchObject({ targetId: "openalex:A1", config: { authorName: "Alex Chen", openAlexId: "A1", semanticScholarId: "3", orcid: id } });
  });

  it.each(["0000-0002-1825-0098", "0000-0002-1825-0XX7"])("does not use invalid ORCID %s as identity evidence", async (invalid) => {
    const authors = await connector([{ id: "A1", display_name: "Chen", orcid: invalid }], [{ authorId: "3", name: "Chen", externalIds: { ORCID: invalid } }]).discover("Chen");
    expect(authors).toHaveLength(2);
    expect(authors.every((author) => !author.config?.orcid)).toBe(true);
  });

  it("deduplicates a repeated provider record without discarding other namesakes", async () => {
    const authors = await connector([{ id: "A1", display_name: "Chen" }, { id: "https://openalex.org/A1", display_name: "Chen" }, { id: "A2", display_name: "Chen" }], []).discover("Chen");
    expect(authors.map((author) => author.targetId)).toEqual(["openalex:A1", "openalex:A2"]);
  });

  it("returns a healthy provider's authors when the other provider fails", async () => {
    const search = new AcademicAuthorConnector(async (url) => url.includes("openalex.org") ? json({ results: [{ id: "A1", display_name: "Chen" }] }) : new Response("{}", { status: 503 }));
    expect(await search.discover("Chen")).toMatchObject([{ targetId: "openalex:A1" }]);
  });

  it("distinguishes an empty successful search from malformed success payloads", async () => {
    expect(await connector([], []).discover("Chen")).toEqual([]);
    await expect(new AcademicAuthorConnector(async () => json({ error: "remote details" })).discover("Chen")).rejects.toThrow("搜索响应无效");
  });

  it("does not issue requests for a blank query", async () => {
    const fetcher = vi.fn();
    expect(await new AcademicAuthorConnector(fetcher).discover("  ")).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
