import type { CheerioAPI } from "cheerio";

/** Positive evidence of a job destination, not a keyword search in article titles. */
export function isRecruitmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "jobs.ashbyhq.com" && /^\/[^/]+\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i.test(url.pathname);
  } catch { return false; }
}

/** Structural evidence applies only to the candidate's own bounded section. */
export function isRecruitmentContext($: CheerioAPI, element: any): boolean {
  let current = $(element);
  while (current.length && !current.is("body, html, main")) {
    const type = current.attr("itemtype") || "";
    if (/(?:^|\s)https?:\/\/schema\.org\/JobPosting(?:\s|$)/.test(type)) return true;
    const identity = `${current.attr("id") || ""} ${current.attr("class") || ""}`.replace(/([a-z])([A-Z])/g, "$1 $2");
    if (/(?:^|[-_\s])(?:careers?|job-list|job-card|open-roles|open-positions|recruitment)(?:$|[-_\s])/i.test(identity)) return true;
    // A heading immediately preceding this list scopes it; an earlier heading
    // from another section must not leak across the intervening heading.
    const heading = current.prevAll("h1,h2,h3,h4,h5,h6").first();
    const label = heading.text().replace(/\s+/g, " ").trim();
    if (/^(?:featured roles|open (?:roles|positions)|career(?:s| opportunities)?|job openings|we['’]re hiring|work (?:at|with) .+|招聘(?:职位|岗位)?|加入我们)$/i.test(label)) return true;
    current = current.parent();
  }
  return false;
}
