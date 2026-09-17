import { describe, expect, it } from "vitest";
import {
  appPackageIdentity,
  distributionPlan,
  hasDeveloperIdIdentity,
  localUnsignedBuilderArguments,
  localUnsignedEnvironment,
  notarizationStrategy,
  publicArtifactCandidates
} from "../scripts/release.mjs";

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

  it("only selects the public path when both signing and notarization are configured", () => {
    expect(distributionPlan('1) AABBCC "Developer ID Application: Reading Hub (TEAM123)"', {
      APPLE_KEYCHAIN_PROFILE: "reading-hub-notary"
    })).toMatchObject({ kind: "signed", notarization: "keychain-profile" });

    expect(distributionPlan("0 valid identities found", {
      APPLE_KEYCHAIN_PROFILE: "reading-hub-notary"
    })).toMatchObject({ kind: "local-unsigned" });

    expect(distributionPlan('1) AABBCC "Developer ID Application: Reading Hub (TEAM123)"', {})).toMatchObject({
      kind: "local-unsigned"
    });
  });

  it("makes a local package unmistakably unsigned even when CI credentials are inherited", () => {
    expect(localUnsignedBuilderArguments("/project/release/local/2026-09-17T00-00-00-000Z")).toEqual(expect.arrayContaining([
      "--config.forceCodeSigning=false",
      "--config.mac.identity=null",
      "--config.mac.notarize=false",
      "--config.dmg.title=Reading Hub (Local Unsigned)",
      "--config.dmg.artifactName=${productName}-${version}-${arch}-local-unsigned.${ext}"
    ]));

    const environment = localUnsignedEnvironment({
      CSC_LINK: "https://ci.example/certificate.p12",
      CSC_KEY_PASSWORD: "secret",
      APPLE_KEYCHAIN_PROFILE: "reading-hub-notary",
      KEEP: "value"
    });
    expect(environment.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(environment.CSC_LINK).toBeUndefined();
    expect(environment.CSC_KEY_PASSWORD).toBeUndefined();
    expect(environment.APPLE_KEYCHAIN_PROFILE).toBeUndefined();
    expect(environment.KEEP).toBe("value");
  });

  it("limits formal verification to the current version and architecture artifacts", () => {
    expect(publicArtifactCandidates({ productName: "Reading Hub", version: "0.1.1" }, "arm64")).toEqual([
      "Reading Hub-0.1.1-arm64.dmg",
      "Reading Hub-0.1.1.dmg"
    ]);
    expect(publicArtifactCandidates({ productName: "Reading Hub", version: "0.1.1" }, "x64")).toEqual([
      "Reading Hub-0.1.1.dmg",
      "Reading Hub-0.1.1-x64.dmg"
    ]);
  });

  it("reads the product name from electron-builder configuration", () => {
    expect(appPackageIdentity({
      version: "0.1.1",
      build: { productName: "Reading Hub" }
    })).toEqual({ productName: "Reading Hub", version: "0.1.1" });
  });
});
