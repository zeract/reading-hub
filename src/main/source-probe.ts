import { extractGenericPage } from "./extractor";
import { discoverFeedUrls, parseFeed, looksLikeFeed } from "./feed";
import { NetworkRequestError, PublicHttpClient } from "./http";
import type { PageRenderer } from "./page-renderer";
import type { CalibrationResult, ProbeResult, RawEntry } from "../shared/types";
import { assertFeedSubscriptionUrl, assertPublicUrl, isTrustedLoopbackFeedUrl } from "../shared/url";
import { extractCalibrationCandidates } from "./extractor";

export class SourceProbe {
  constructor(private readonly http: PublicHttpClient, private readonly renderer?: PageRenderer) {}

  async probe(rawUrl: string): Promise<ProbeResult> {
    const localFeed = isTrustedLoopbackFeedUrl(rawUrl);
    const input = localFeed ? assertFeedSubscriptionUrl(rawUrl, true).toString() : assertPublicUrl(rawUrl).toString();
    assertSupportedPublicProbeUrl(input);
    let response;
    try {
      response = await this.http.getText(input, undefined, localFeed ? { allowTrustedLoopbackFeed: true } : undefined);
    } catch (error) {
      if (localFeed) throw error;
      if (!(error instanceof NetworkRequestError) || !this.renderer) throw error;
      try {
        const rendered = await this.renderer.render(input);
        const extraction = extractGenericPage(rendered, input);
        return {
          kind: "generic",
          title: extraction.title,
          url: input,
          confidence: extraction.confidence,
          extractionRule: extraction.rule ? { ...extraction.rule, rendererRequired: true } : undefined,
          preview: extraction.entries.slice(0, 10),
          requiresReview: extraction.fallback || extraction.confidence < 0.75,
          message: "已使用浏览器渲染模式识别该公开网页。"
        };
      } catch {
        throw error;
      }
    }
    if (looksLikeFeed(response.contentType, response.text)) {
      const feed = await parseFeed(response.text, response.url);
      return {
        kind: "rss",
        title: feed.title,
        url: response.url,
        confidence: 1,
        preview: feed.entries.slice(0, 10),
        requiresReview: false,
        message: localFeed ? "已验证本机 Feed；只会按 RSS/Atom/JSON Feed 读取。" : undefined
      };
    }

    if (localFeed) throw new Error("本机地址只支持 RSS、Atom 或 JSON Feed，不能用于网页结构提取。");

    for (const feedUrl of discoverFeedUrls(response.text, response.url)) {
      try {
        const feedResponse = await this.http.getText(feedUrl);
        if (!looksLikeFeed(feedResponse.contentType, feedResponse.text)) continue;
        const feed = await parseFeed(feedResponse.text, feedResponse.url);
        return { kind: "rss", title: feed.title, url: feedResponse.url, confidence: 0.98, preview: feed.entries.slice(0, 10), requiresReview: false };
      } catch {
        // A broken alternate link should not prevent the generic-page fallback.
      }
    }

    let extraction = extractGenericPage(response.text, response.url);
    if (extraction.entries.length < 2 && this.renderer) {
      try {
        const rendered = await this.renderer.render(response.url);
        const renderedExtraction = extractGenericPage(rendered, response.url);
        if (renderedExtraction.entries.length > extraction.entries.length) {
          extraction = {
            ...renderedExtraction,
            rule: renderedExtraction.rule ? { ...renderedExtraction.rule, rendererRequired: true } : undefined
          };
        }
      } catch {
        // Rendering is best-effort and never grants access to an authenticated browser session.
      }
    }
    return {
      kind: "generic",
      title: extraction.title,
      url: response.url,
      confidence: extraction.confidence,
      extractionRule: extraction.rule,
      preview: extraction.entries.slice(0, 10),
      requiresReview: extraction.fallback || extraction.confidence < 0.75,
      message: extraction.fallback ? "未找到稳定的列表结构，已降级为页面预览。" : undefined
    };
  }

  async calibrate(rawUrl: string): Promise<CalibrationResult> {
    const input = assertPublicUrl(rawUrl).toString();
    assertSupportedPublicProbeUrl(input);
    let html: string;
    let pageUrl: string;
    try {
      const response = await this.http.getText(input);
      html = response.text;
      pageUrl = response.url;
    } catch (error) {
      if (!(error instanceof NetworkRequestError) || !this.renderer) throw error;
      try {
        html = await this.renderer.render(input);
        pageUrl = input;
      } catch {
        throw error;
      }
    }
    let candidates = extractCalibrationCandidates(html, pageUrl);
    if (candidates.length < 2 && this.renderer) {
      try {
        const rendered = await this.renderer.render(pageUrl);
        const renderedCandidates = extractCalibrationCandidates(rendered, pageUrl).map((candidate) => ({
          ...candidate,
          rule: { ...candidate.rule, rendererRequired: true }
        }));
        if (renderedCandidates.length > candidates.length) candidates = renderedCandidates;
      } catch {
        // Static candidates are still useful if a page blocks the isolated renderer.
      }
    }
    const title = extractGenericPage(html, pageUrl).title;
    return {
      title,
      url: pageUrl,
      candidates,
      message: candidates.length ? undefined : "还没有找到可稳定重复的内容卡片；请稍后重试，或等待网站加载后再校准。"
    };
  }
}

export function isXiaohongshuUrl(url: string): boolean {
  try {
    return /(^|\.)xiaohongshu\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * X explicitly blocks generic crawler access on its profile pages. Detect it
 * before the public probe touches the network so pasting a profile URL into
 * “网页 / Feed” gives a product-level explanation rather than an IPC error.
 */
export function isXUrl(url: string): boolean {
  try {
    return /(^|\.)(?:x|twitter)\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function assertSupportedPublicProbeUrl(url: string): void {
  if (!isXUrl(url)) return;
  throw new Error("X 主页不能通过“网页 / Feed”自动探测：X 的 robots.txt 禁止自动读取。请在“X 动态”中查看可用连接方式；当前免 API 的公开自动订阅同样受此限制，Reading Hub 不会使用 Cookie、登录态或私有 Web API 绕过它。");
}

export function manualProbe(url: string, preview: RawEntry[], title: string): ProbeResult {
  return {
    kind: "manual",
    title: title || "手动分享",
    url,
    confidence: 1,
    preview,
    requiresReview: false,
    message: "该链接会保存为一次性阅读卡片，不会自动轮询。"
  };
}
