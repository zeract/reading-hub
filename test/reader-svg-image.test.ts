import { expect, it } from "vitest";
import { load } from "cheerio";
import { sanitizeSvgImage } from "../src/main/reader-svg-image";
it("normalizes declared SVG namespaces and excludes foreign namespaces", () => {
  const result=sanitizeSvgImage(Buffer.from(`<s:svg xmlns:s="http://www.w3.org/2000/svg" xmlns:other="https://untrusted.example/" width="10" height="10"><s:g><s:rect width="10" height="10"/><s:text>Label</s:text></s:g><other:text>Foreign</other:text></s:svg>`)).toString();
  const $=load(result,{xml:true});
  expect($('svg > g > rect').length).toBe(1);expect($('text').text()).toBe('Label');
  expect(result).not.toContain('<s:');expect(result).not.toContain('Foreign');
  expect(()=>sanitizeSvgImage(Buffer.from('<s:svg xmlns:s="https://untrusted.example/"/>'))).toThrow('格式无效');
});
