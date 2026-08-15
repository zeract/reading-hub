import keytar from "keytar";

const SERVICE = "com.local.readinghub";
const ZHIHU_ACCOUNT = "zhihu-access-secret";

export class SecretStore {
  async setZhihuAccessSecret(value: string): Promise<void> {
    const secret = value.trim();
    if (!secret) throw new Error("Access Secret 不能为空。");
    await keytar.setPassword(SERVICE, ZHIHU_ACCOUNT, secret);
  }

  async getZhihuAccessSecret(): Promise<string | null> {
    return keytar.getPassword(SERVICE, ZHIHU_ACCOUNT);
  }

  async clearZhihuAccessSecret(): Promise<void> {
    await keytar.deletePassword(SERVICE, ZHIHU_ACCOUNT);
  }

  /** Stores opaque OAuth/API material under a connector-scoped Keychain item. */
  async setConnectorSecret(connectorId: string, accountId: string, value: string): Promise<string> {
    if (!value.trim()) throw new Error("授权凭证不能为空。");
    const keychainAccount = `${connectorId}:${accountId}`;
    await keytar.setPassword(SERVICE, keychainAccount, value);
    return keychainAccount;
  }

  async getConnectorSecret(keychainAccount?: string): Promise<string | null> {
    if (!keychainAccount) return null;
    return keytar.getPassword(SERVICE, keychainAccount);
  }

  async clearConnectorSecret(keychainAccount?: string): Promise<void> {
    if (keychainAccount) await keytar.deletePassword(SERVICE, keychainAccount);
  }
}
