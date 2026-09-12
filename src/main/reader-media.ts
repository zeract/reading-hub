import { load } from "cheerio";
import { parseSrcset } from "../shared/srcset";
import { publicDocumentUrl as safeUrl } from "./html-document-url";
const normalText=(value:string)=>value.replace(/\s+/g," ").trim();
/** Hydrates common lazy-image and <picture> patterns before stripping markup. */
export function hydrateLazyImages($: ReturnType<typeof load>, root: any, pageUrl: string): void {
  root.find("picture").each((_index: number, node: any) => {
    const picture = $(node);
    const image = picture.find("img").first();
    const source = picture.find("source").toArray().map((item: any) => $(item).attr("data-srcset") || $(item).attr("srcset")).find(Boolean);
    if (image.length && source && !image.attr("data-reader-picture-srcset")) image.attr("data-reader-picture-srcset", source);
  });

  root.find("noscript").each((_index: number, node: any) => {
    const fallback = load($(node).text() || $(node).html() || "", {}, false);
    const fallbackImages = fallback("img");
    if (!fallbackImages.length) return;
    const previousImage = $(node).prev("img");
    const replacement = $("<div>");
    fallbackImages.each((_fallbackIndex, fallbackNode) => {
      const fallbackImage = fallback(fallbackNode);
      const fallbackSrc = imageSource(fallbackImage, pageUrl);
      if (!fallbackSrc) return;
      const neighbours = $(node).prev().add($(node).next());
      const candidates = $(node).siblings("img").toArray();
      neighbours.each((_index: number, sibling: any) => {
        const wrapper = $(sibling);
        // A transparent media wrapper still belongs to this fallback pair.
        // Do not search across prose or separate authored figures.
        if (wrapper.is("a, span, div, picture") && !normalText(wrapper.text()) && !wrapper.find("figure, figcaption").length) {
          candidates.push(...wrapper.find("img").toArray());
        }
      });
      const fallbackKeys = new Set(imageSources(fallbackImage, pageUrl).map(imageAssetKey));
      const equivalentSibling = candidates.map((sibling: any) => $(sibling)).find((image: any) => {
        const selectedKey = imageAssetKey(imageSource(image, pageUrl));
        return fallbackKeys.has(selectedKey) || imageSources(image, pageUrl).some((url) => imageAssetKey(url) === imageAssetKey(fallbackSrc));
      });
      // WordPress can put the static fallback before a lazy sibling. Merge
      // only an equivalent asset; adjacency alone does not establish identity.
      const targetImage = equivalentSibling || (previousImage.length && !imageSource(previousImage, pageUrl) ? previousImage : undefined);
      if (targetImage) {
        if (!equivalentSibling) targetImage.attr("data-reader-noscript-src", fallbackSrc);
        const srcset = fallbackImage.attr("data-srcset") || fallbackImage.attr("srcset");
        if (srcset && !targetImage.attr("data-reader-noscript-srcset")) targetImage.attr("data-reader-noscript-srcset", srcset);
        const alt = normalText(fallbackImage.attr("alt") || "");
        if (alt && !normalText(targetImage.attr("alt") || "")) targetImage.attr("alt", alt);
        return;
      }
      // Keep every distinct fallback in author order. Copy only validated
      // image data, never the fallback's links, event handlers, or wrappers.
      const image = $("<img>");
      image.attr("src", fallbackSrc);
      const alt = normalText(fallbackImage.attr("alt") || "");
      if (alt) image.attr("alt", alt);
      replacement.append(image);
    });
    $(node).replaceWith(replacement.children());
  });
  removeLocalDuplicateImages($, root, pageUrl);
}

/**
 * A source can contain both an accessible fallback and a client-side image in
 * one figure. Dedupe only inside one media container (or direct siblings), so
 * an author can still intentionally use the same illustration in two separate
 * figures elsewhere in the article.
 */
function removeLocalDuplicateImages($: ReturnType<typeof load>, root: any, pageUrl: string): void {
  root.find("figure, picture").each((_index: number, node: any) => removeDuplicateImagesIn($, $(node), pageUrl));
  root.children().each((_index: number, node: any) => {
    const container = $(node);
    if (container.is("figure, picture")) return;
    const images = container.children("img");
    if (images.length > 1) removeDuplicateImagesIn($, container, pageUrl, true);
  });
}

function removeDuplicateImagesIn($: ReturnType<typeof load>, container: any, pageUrl: string, directOnly = false): void {
  const seen = new Set<string>();
  const images = directOnly ? container.children("img").toArray() : container.find("img").toArray();
  for (const node of images) {
    const image = $(node);
    const src = imageSource(image, pageUrl);
    const key = imageAssetKey(src);
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    const parentLink = image.parent("a");
    image.remove();
    if (parentLink.length && !parentLink.find("img").length && !normalText(parentLink.text())) parentLink.remove();
  }
}

/**
 * Metadata is a fallback illustration, not authored body content. Social cards
 * can be crops or separately named exports of a body image, so URL identity
 * cannot establish whether adding one would duplicate the publisher's layout.
 * Preserve the body and only supplement image-free articles after sanitization.
 */
export function selectReaderCover(contentHtml: string, candidate?: string): string | undefined {
  return candidate && !load(contentHtml)("img, video").length ? candidate : undefined;
}

function imageUrlKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * A CMS commonly emits the same original image in several generated sizes,
 * for example `Figure1.png` and `Figure1-625x125.png`. These are one visual
 * asset when they coexist in a single article image block. Keep the exact URL
 * for rendering, but compare their stable asset identity for deduplication.
 */
function imageAssetKey(value: string | undefined): string | undefined {
  const key = imageUrlKey(value);
  if (!key) return undefined;
  try {
    const url = new URL(key);
    url.pathname = url.pathname.replace(/-\d{1,5}x\d{1,5}(?=\.[a-z0-9]{2,5}$)/i, "");
    return url.toString();
  } catch {
    return key.replace(/-\d{1,5}x\d{1,5}(?=\.[a-z0-9]{2,5}(?:[?#]|$))/i, "");
  }
}

export function imageSource(element: any, pageUrl: string): string | undefined {
  return imageSources(element, pageUrl)[0];
}

/** Ordered, validated candidates retain the publisher's image equivalence. */
function imageSources(element: any, pageUrl: string): string[] {
  const srcsets = [
    element.attr("data-srcset"),
    element.attr("data-lazy-srcset"),
    element.attr("data-reader-picture-srcset"),
    element.attr("data-reader-noscript-srcset"),
    element.attr("srcset")
  ];
  const values = [
    element.attr("data-actualsrc"),
    element.attr("data-original"),
    element.attr("data-original-src"),
    // A srcset describes resolution variants of the same image. The reader
    // has no viewport-specific source selection to preserve, so retain its
    // largest safe candidate instead of a lazy loader's lower-resolution
    // data-src placeholder.
    ...srcsets.flatMap((srcset) => parseSrcset(srcset)
      .sort((left, right) => (right.width ?? right.density ?? 1) - (left.width ?? left.density ?? 1))
      .map((candidate) => candidate.url)),
    element.attr("data-src"),
    element.attr("data-lazy-src"),
    element.attr("data-reader-noscript-src"),
    element.attr("src")
  ];
  return [...new Set(values.map((value) => safeUrl(value, pageUrl)).filter((value): value is string => Boolean(value)))];
}

