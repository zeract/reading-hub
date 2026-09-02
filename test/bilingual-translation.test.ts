import { describe, expect, it } from "vitest";
import { bilingualTranslationLabel, bilingualTranslationQuestion, bilingualTranslationTarget } from "../src/renderer/bilingual-translation";

describe("bilingual article translation defaults", () => {
  it("offers English for Chinese publisher pages and Chinese otherwise", () => {
    expect(bilingualTranslationTarget("zh-CN")).toBe("en");
    expect(bilingualTranslationTarget("zh")).toBe("en");
    expect(bilingualTranslationTarget("en-US")).toBe("zh");
    expect(bilingualTranslationTarget()).toBe("zh");
  });

  it("keeps output labels and required transport questions independent of article text", () => {
    expect(bilingualTranslationLabel("zh")).toBe("中文译文");
    expect(bilingualTranslationLabel("en")).toBe("English translation");
    expect(bilingualTranslationQuestion("zh")).not.toContain("<article-excerpt>");
    expect(bilingualTranslationQuestion("en")).toContain("English");
  });
});
