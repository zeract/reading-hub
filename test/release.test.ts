import { describe, expect, it } from "vitest";
import { hasDeveloperIdIdentity, notarizationStrategy } from "../scripts/release.mjs";

describe("macOS distribution release gate", () => {
  it("accepts a complete App Store Connect API-key notarization configuration", () => {
    expect(notarizationStrategy({
      APPLE_API_KEY: "/secure/AuthKey_ABC123.p8",
      APPLE_API_KEY_ID: "ABC123DEF4",
      APPLE_API_ISSUER: "89abc123-4567-4def-8123-456789abcdef"
    })).toBe("api-key");
  });

  it("accepts a Keychain-based notarization profile without exposing a password", () => {
    expect(notarizationStrategy({ APPLE_KEYCHAIN_PROFILE: "reading-hub-notary" })).toBe("keychain-profile");
  });

  it("rejects incomplete or absent notarization credentials before packaging", () => {
    expect(() => notarizationStrategy({ APPLE_ID: "owner@example.com" })).toThrow("公证凭证不完整");
    expect(() => notarizationStrategy({})).toThrow("不能创建可公开分发的 DMG");
  });

  it("requires a Developer ID identity unless electron-builder receives a secure CSC_LINK", () => {
    expect(hasDeveloperIdIdentity('1) AABBCC "Developer ID Application: Reading Hub (TEAM123)"', {})).toBe(true);
    expect(hasDeveloperIdIdentity("0 valid identities found", {})).toBe(false);
    expect(hasDeveloperIdIdentity("0 valid identities found", { CSC_LINK: "https://ci.example/certificate.p12" })).toBe(true);
  });
});
