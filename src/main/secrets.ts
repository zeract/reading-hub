import keytar from "keytar";
import { KeyedTaskQueue } from "./keyed-task-queue";

const SERVICE = "com.local.readinghub";
const ZHIHU_ACCOUNT = "zhihu-access-secret";

export class SecretStore {
  // Native Keychain promises may settle out of order. Serialize each record's
  // reads and mutations while allowing independent accounts to progress.
  private readonly tasks = new KeyedTaskQueue();

  async setZhihuAccessSecret(value: string): Promise<void> {
    const secret = value.trim();
    if (!secret) throw new Error("Access Secret 不能为空。");
    await this.tasks.run(ZHIHU_ACCOUNT, () => keytar.setPassword(SERVICE, ZHIHU_ACCOUNT, secret));
  }

  async getZhihuAccessSecret(): Promise<string | null> {
    return this.tasks.run(ZHIHU_ACCOUNT, () => keytar.getPassword(SERVICE, ZHIHU_ACCOUNT));
  }

  async clearZhihuAccessSecret(): Promise<void> {
    await this.tasks.run(ZHIHU_ACCOUNT, () => keytar.deletePassword(SERVICE, ZHIHU_ACCOUNT));
  }

  /** Stores opaque OAuth/API material under a connector-scoped Keychain item. */
  async setConnectorSecret(connectorId: string, accountId: string, value: string): Promise<string> {
    if (!value.trim()) throw new Error("授权凭证不能为空。");
    const keychainAccount = `${connectorId}:${accountId}`;
    await this.tasks.run(keychainAccount, () => keytar.setPassword(SERVICE, keychainAccount, value));
    return keychainAccount;
  }

  async getConnectorSecret(keychainAccount?: string): Promise<string | null> {
    if (!keychainAccount) return null;
    return this.tasks.run(keychainAccount, () => keytar.getPassword(SERVICE, keychainAccount));
  }

  async clearConnectorSecret(keychainAccount?: string): Promise<void> {
    if (keychainAccount) await this.tasks.run(keychainAccount, () => keytar.deletePassword(SERVICE, keychainAccount));
  }
}
