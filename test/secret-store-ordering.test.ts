import { beforeEach, expect, it, vi } from "vitest";
import { SecretStore } from "../src/main/secrets";

const keychain = vi.hoisted(() => ({ getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn() }));
vi.mock("keytar", () => ({ default: keychain }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
let values: Map<string, string>;
beforeEach(() => {
  vi.resetAllMocks();
  values = new Map();
  keychain.getPassword.mockImplementation(async (_service, key) => values.get(key) ?? null);
  keychain.setPassword.mockImplementation(async (_service, key, value) => { values.set(key, value); });
  keychain.deletePassword.mockImplementation(async (_service, key) => values.delete(key));
});

it.each(["zhihu", "connector"])("preserves the latest %s write when the earlier native write is slow", async (kind) => {
  const store = new SecretStore();
  const gate = deferred();
  keychain.setPassword.mockImplementationOnce(async (_service, key, value) => { await gate.promise; values.set(key, value); });
  const write = (value: string) => kind === "zhihu" ? store.setZhihuAccessSecret(value) : store.setConnectorSecret("fixture", "account", value);
  const read = () => kind === "zhihu" ? store.getZhihuAccessSecret() : store.getConnectorSecret("fixture:account");
  const first = write("fixture-old");
  const second = write("fixture-new");
  try {
    await vi.waitFor(() => expect(keychain.setPassword).toHaveBeenCalled());
    expect(keychain.setPassword).toHaveBeenCalledTimes(1);
  } finally { gate.resolve(); await Promise.allSettled([first, second]); }
  expect(await read()).toBe("fixture-new");
});

it.each(["zhihu", "connector"])("does not resurrect %s credentials when a pending save is followed by delete and read", async (kind) => {
  const store = new SecretStore();
  const gate = deferred();
  keychain.setPassword.mockImplementationOnce(async (_service, key, value) => { await gate.promise; values.set(key, value); });
  const save = kind === "zhihu" ? store.setZhihuAccessSecret("fixture-value") : store.setConnectorSecret("fixture", "account", "fixture-value");
  const clear = kind === "zhihu" ? store.clearZhihuAccessSecret() : store.clearConnectorSecret("fixture:account");
  const read = kind === "zhihu" ? store.getZhihuAccessSecret() : store.getConnectorSecret("fixture:account");
  try {
    await vi.waitFor(() => expect(keychain.setPassword).toHaveBeenCalledTimes(1));
    expect(keychain.deletePassword).not.toHaveBeenCalled();
    expect(keychain.getPassword).not.toHaveBeenCalled();
  } finally { gate.resolve(); await Promise.allSettled([save, clear, read]); }
  expect(await read).toBeNull();
  expect(values.size).toBe(0);
});

it("reads the preceding committed save rather than a stale native snapshot", async () => {
  const store = new SecretStore();
  const gate = deferred();
  keychain.setPassword.mockImplementationOnce(async (_service, key, value) => { await gate.promise; values.set(key, value); });
  const save = store.setConnectorSecret("fixture", "account", "fixture-value");
  const read = store.getConnectorSecret("fixture:account");
  gate.resolve();
  await save;
  expect(await read).toBe("fixture-value");
});

it("allows other records to progress and recovers the queue after a native write failure", async () => {
  const store = new SecretStore();
  const gate = deferred();
  const failure = new Error("Fixture native failure");
  keychain.setPassword.mockImplementationOnce(async () => { await gate.promise; throw failure; });
  const failed = store.setConnectorSecret("fixture", "first", "fixture-old").catch((error) => error);
  await vi.waitFor(() => expect(keychain.setPassword).toHaveBeenCalledTimes(1));
  const replacement = store.setConnectorSecret("fixture", "first", "fixture-replacement");
  try {
    expect(await store.setConnectorSecret("fixture", "second", "fixture-other")).toBe("fixture:second");
    expect(await store.getConnectorSecret("fixture:second")).toBe("fixture-other");
  } finally { gate.resolve(); await Promise.allSettled([failed, replacement]); }
  expect(await failed).toBe(failure);
  expect(await store.getConnectorSecret("fixture:first")).toBe("fixture-replacement");
});

it("preserves validation, opaque connector values and missing-key behavior", async () => {
  const store = new SecretStore();
  await expect(store.setZhihuAccessSecret(" ")).rejects.toThrow("不能为空");
  await expect(store.setConnectorSecret("fixture", "account", " ")).rejects.toThrow("不能为空");
  expect(await store.getConnectorSecret()).toBeNull();
  await store.clearConnectorSecret();
  expect(keychain.setPassword).not.toHaveBeenCalled();
  expect(keychain.getPassword).not.toHaveBeenCalled();
  expect(keychain.deletePassword).not.toHaveBeenCalled();
  await store.setConnectorSecret("fixture", "account", "  fixture-opaque  ");
  expect(await store.getConnectorSecret("fixture:account")).toBe("  fixture-opaque  ");
  await store.setZhihuAccessSecret("  fixture-zhihu  ");
  expect(await store.getZhihuAccessSecret()).toBe("fixture-zhihu");
});
