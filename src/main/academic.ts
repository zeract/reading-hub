import type { ConnectorAdapter, RawEntry, Source, SubscriptionDraft, SyncContext, SyncResult } from "../shared/types";
import { compactText } from "../shared/text";
import { builtInManifest } from "./connector-registry";
import { contentNormalizer } from "./content-normalizer";
import { chromiumFetch } from "./network";

const OPENALEX_ROOT = "https://api.openalex.org";
const SEMANTIC_ROOT = "https://api.semanticscholar.org/graph/v1";
const ORCID_ROOT = "https://pub.orcid.org/v3.0";

type AuthorConfig = {
  authorName: string;
  openAlexId?: string;
  semanticScholarId?: string;
  orcid?: string;
};

type AcademicFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Public-record scholarly aggregation, explicitly not a Google Scholar scraper. */
export class AcademicAuthorConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest(
    "academic",
    "学术作者更新",
    ["public-http", "author-search"],
    ["api.openalex.org", "api.semanticscholar.org", "pub.orcid.org"]
  );

  constructor(private readonly fetchJson: AcademicFetch = chromiumFetch) {}

  async discover(input: string): Promise<SubscriptionDraft[]> {
    const query = input.trim();
    if (!query) return [];
    const [openAlex, semantic] = await Promise.allSettled([this.searchOpenAlex(query), this.searchSemantic(query)]);
    const drafts: SubscriptionDraft[] = [];
    if (openAlex.status === "fulfilled") drafts.push(...openAlex.value);
    if (semantic.status === "fulfilled") drafts.push(...semantic.value);
    return mergeDrafts(drafts);
  }

  async sync(context: SyncContext): Promise<SyncResult> {
    const config = readAuthorConfig(context.subscription.config);
    if (!config.authorName || (!config.openAlexId && !config.semanticScholarId && !config.orcid)) {
      throw new Error("请至少选择一个学术数据库中的作者身份。");
    }
    const result = await Promise.allSettled([
      config.openAlexId ? this.fetchOpenAlex(config) : Promise.resolve([]),
      config.semanticScholarId ? this.fetchSemantic(config) : Promise.resolve([]),
      config.orcid ? this.fetchOrcid(config) : Promise.resolve([])
    ]);
    const entries = result.flatMap((item) => item.status === "fulfilled" ? item.value : []);
    if (!entries.length && result.every((item) => item.status === "rejected")) {
      const message = result.find((item): item is PromiseRejectedResult => item.status === "rejected")?.reason;
      throw message instanceof Error ? message : new Error("学术数据源暂时不可用。");
    }
    return { entries, emptyIsHealthy: true, checkpoint: { data: { lastProviderCheckAt: Date.now() } } };
  }

  normalize(item: RawEntry, source: Source) {
    return contentNormalizer.normalize(item, source, ACADEMIC_CONTENT_NORMALIZATION);
  }

  private async searchOpenAlex(query: string): Promise<SubscriptionDraft[]> {
    const url = new URL("/authors", OPENALEX_ROOT);
    url.search = new URLSearchParams({ search: query, per_page: "10" }).toString();
    const payload = await this.requestJson<{ results?: Array<{ id?: string; display_name?: string; orcid?: string; works_count?: number }> }>(url);
    return (payload.results || []).flatMap((author) => {
      const id = normalOpenAlexId(author.id);
      const name = compactText(author.display_name, 160);
      if (!id || !name) return [];
      return [{
        title: `${name} · OpenAlex`,
        targetId: `openalex:${id}`,
        config: { authorName: name, openAlexId: id, orcid: normalOrcid(author.orcid) }
      }];
    });
  }

  private async searchSemantic(query: string): Promise<SubscriptionDraft[]> {
    const url = new URL("author/search", `${SEMANTIC_ROOT}/`);
    url.search = new URLSearchParams({ query, limit: "10", fields: "name,paperCount,externalIds" }).toString();
    const payload = await this.requestJson<{ data?: Array<{ authorId?: string; name?: string; externalIds?: { ORCID?: string } }> }>(url);
    return (payload.data || []).flatMap((author) => {
      const id = author.authorId;
      const name = compactText(author.name, 160);
      if (!id || !name) return [];
      return [{
        title: `${name} · Semantic Scholar`,
        targetId: `semantic:${id}`,
        config: { authorName: name, semanticScholarId: id, orcid: normalOrcid(author.externalIds?.ORCID) }
      }];
    });
  }

  private async fetchOpenAlex(config: AuthorConfig): Promise<RawEntry[]> {
    const url = new URL("/works", OPENALEX_ROOT);
    url.search = new URLSearchParams({
      filter: `authorships.author.id:${normalOpenAlexId(config.openAlexId)}`,
      sort: "publication_date:desc",
      per_page: "100",
      select: "id,doi,title,publication_date,authorships,primary_location,type"
    }).toString();
    const payload = await this.requestJson<{ results?: Array<any> }>(url);
    return (payload.results || []).flatMap((work) => {
      const doi = normalDoi(work.doi);
      const landing = work.primary_location?.landing_page_url || work.id;
      const title = compactText(work.title, 500);
      if (!landing || !title) return [];
      return [{
        url: doi ? `https://doi.org/${doi}` : landing,
        title,
        author: config.authorName,
        publishedAt: parseDate(work.publication_date),
        summary: "OpenAlex · 学术论文",
        externalId: String(work.id || doi || landing),
        canonicalIdentity: doi ? `doi:${doi}` : `openalex:${work.id || landing}`,
        observedAt: Date.now(),
        providerId: "academic",
        providerLabel: "OpenAlex"
      }];
    });
  }

  private async fetchSemantic(config: AuthorConfig): Promise<RawEntry[]> {
    const id = encodeURIComponent(config.semanticScholarId || "");
    const url = new URL(`author/${id}/papers`, `${SEMANTIC_ROOT}/`);
    url.search = new URLSearchParams({ limit: "100", fields: "paperId,title,abstract,publicationDate,externalIds,openAccessPdf,url" }).toString();
    const payload = await this.requestJson<{ data?: Array<any> }>(url);
    return (payload.data || []).flatMap((paper) => {
      const doi = normalDoi(paper.externalIds?.DOI);
      const arxiv = stringValue(paper.externalIds?.ArXiv);
      const landing = paper.url || paper.openAccessPdf?.url || (doi ? `https://doi.org/${doi}` : undefined);
      const title = compactText(paper.title, 500);
      if (!landing || !title) return [];
      return [{
        url: doi ? `https://doi.org/${doi}` : landing,
        title,
        author: config.authorName,
        publishedAt: parseDate(paper.publicationDate),
        summary: compactText(paper.abstract, 600) || "Semantic Scholar · 学术论文",
        externalId: String(paper.paperId || doi || landing),
        canonicalIdentity: doi ? `doi:${doi}` : arxiv ? `arxiv:${arxiv.toLowerCase()}` : `semantic:${paper.paperId || landing}`,
        observedAt: Date.now(),
        providerId: "academic",
        providerLabel: "Semantic Scholar"
      }];
    });
  }

  private async fetchOrcid(config: AuthorConfig): Promise<RawEntry[]> {
    const id = encodeURIComponent(config.orcid || "");
    const payload = await this.requestJson<any>(new URL(`${id}/works`, `${ORCID_ROOT}/`), { accept: "application/json" });
    const groups = payload.group || [];
    return groups.flatMap((group: any) => {
      const summary = group["work-summary"]?.[0];
      const title = compactText(summary?.title?.title?.value, 500);
      const external = summary?.["external-ids"]?.["external-id"] || [];
      const doi = normalDoi(external.find((item: any) => String(item?.["external-id-type"]).toLowerCase() === "doi")?.["external-id-value"]);
      const url = doi ? `https://doi.org/${doi}` : summary?.url?.value;
      if (!title || !url) return [];
      return [{
        url,
        title,
        author: config.authorName,
        publishedAt: parseOrcidDate(summary?.["publication-date"]),
        summary: "ORCID · 公开 works 记录",
        externalId: String(summary?.["put-code"] || doi || url),
        canonicalIdentity: doi ? `doi:${doi}` : `orcid:${config.orcid}:${summary?.["put-code"] || url}`,
        observedAt: Date.now(),
        providerId: "academic",
        providerLabel: "ORCID"
      }];
    });
  }

  private async requestJson<T>(url: URL, headers: Record<string, string> = {}): Promise<T> {
    if (url.protocol !== "https:" || !["api.openalex.org", "api.semanticscholar.org", "pub.orcid.org"].includes(url.hostname)) {
      throw new Error("学术连接器拒绝访问未授权域名。");
    }
    let response: Response;
    try {
      response = await this.fetchJson(url.toString(), { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error("无法连接到学术数据源。请检查网络、代理或 DNS 设置后重试。");
    }
    const payload = await response.json().catch(() => ({})) as T;
    if (!response.ok) throw new Error(`学术数据源请求失败（${response.status}）。`);
    return payload;
  }
}

const ACADEMIC_CONTENT_NORMALIZATION = {
  // Academic APIs already return their authoritative landing-page URL. The
  // historic connector intentionally retained that exact URL for non-DOI
  // papers, so avoid generic URL rewriting here.
  canonicalizeUrl: (url: string) => url,
  canonicalIdentity: (item: RawEntry) => item.canonicalIdentity || academicContentIdentity(item.url, item.externalId),
  // DOI URLs are stable canonical URLs. For non-DOI works this remains the
  // provider landing page; origin rows retain every provider attribution.
  canonicalUrl: (item: RawEntry, identity: string) => stableCanonicalUrl(identity, item.url),
  hashMode: "identity" as const,
  providerId: "academic" as const
};

function readAuthorConfig(input: Record<string, unknown>): AuthorConfig {
  return {
    authorName: stringValue(input.authorName) || "",
    openAlexId: normalOpenAlexId(stringValue(input.openAlexId)),
    semanticScholarId: stringValue(input.semanticScholarId),
    orcid: normalOrcid(stringValue(input.orcid))
  };
}

function mergeDrafts(drafts: SubscriptionDraft[]): SubscriptionDraft[] {
  const merged = new Map<string, SubscriptionDraft>();
  for (const draft of drafts) {
    const config = draft.config || {};
    const key = stringValue(config.orcid) || String(config.authorName || draft.title).trim().toLocaleLowerCase();
    const previous = merged.get(key);
    if (previous) {
      previous.config = { ...previous.config, ...config };
      previous.title = String(config.authorName || previous.title);
    } else merged.set(key, { ...draft, config: { ...config } });
  }
  return [...merged.values()];
}

function normalOpenAlexId(value: unknown): string | undefined {
  const source = stringValue(value);
  if (!source) return undefined;
  return source.replace(/^https?:\/\/openalex\.org\//i, "").replace(/^authors\//i, "") || undefined;
}

function normalOrcid(value: unknown): string | undefined {
  const source = stringValue(value);
  if (!source) return undefined;
  const id = source.replace(/^https?:\/\/orcid\.org\//i, "").trim();
  return /^\d{4}-\d{4}-\d{4}-[\dX]{4}$/i.test(id) ? id.toUpperCase() : undefined;
}

function normalDoi(value: unknown): string | undefined {
  const source = stringValue(value);
  if (!source) return undefined;
  const doi = source.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim().toLowerCase();
  return /^10\.\d{4,9}\/.+/i.test(doi) ? doi : undefined;
}

function parseDate(value: unknown): number | undefined {
  const string = stringValue(value);
  if (!string) return undefined;
  const result = Date.parse(string);
  return Number.isFinite(result) ? result : undefined;
}

function parseOrcidDate(value: any): number | undefined {
  const year = value?.year?.value;
  if (!year) return undefined;
  const month = String(value?.month?.value || "01").padStart(2, "0");
  const day = String(value?.day?.value || "01").padStart(2, "0");
  return parseDate(`${year}-${month}-${day}`);
}

function academicContentIdentity(url: string, externalId?: string): string {
  const doi = normalDoi(url);
  return doi ? `doi:${doi}` : externalId ? `academic:${externalId}` : `url:${url}`;
}

function stableCanonicalUrl(identity: string, fallback: string): string {
  if (identity.startsWith("doi:")) return `https://doi.org/${identity.slice(4)}`;
  return fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
