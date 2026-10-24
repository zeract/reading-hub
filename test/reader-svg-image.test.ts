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

it.each([
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
  '<!DOCTYPE svg SYSTEM "file:///private/never-fetch.dtd">',
  '<!DOCTYPE svg>'
])("discards inert SVG declarations without retaining or resolving them", declaration => {
  const result=sanitizeSvgImage(Buffer.from(`<?xml version="1.0"?>${declaration}<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`)).toString();
  expect(result).toContain('<rect');expect(result).not.toMatch(/DOCTYPE|SYSTEM|PUBLIC|file:/);
});
it.each(['<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private/key">]>', '<!DOCTYPE svg [<!ELEMENT svg ANY>]>', '<!DOCTYPE html>', '<!DOCTYPE svg SYSTEM "x.dtd" [ ]>'])("rejects unsupported declarations and subsets", declaration => {
  expect(()=>sanitizeSvgImage(Buffer.from(declaration+'<svg/>'))).toThrow('文档声明');
});
