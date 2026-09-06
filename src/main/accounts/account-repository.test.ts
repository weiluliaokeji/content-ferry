import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { AccountRepository } from "./account-repository";

describe("AccountRepository 51CTO category options", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  const setup = () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "51cto", displayName: "51CTO 账号" });
    return { accounts, accountId: account.id };
  };

  it("persists and reads back the pid-grouped second-level categories", () => {
    const { accounts, accountId } = setup();
    const saved = accounts.saveFiftyoneCtoOptions(
      accountId,
      [{ value: "176", label: "后端" }, { value: "177", label: "前端" }],
      [{ value: "200", label: "Java" }, { value: "201", label: "Vue" }],
      { "176": [{ value: "200", label: "Java" }], "177": [{ value: "201", label: "Vue" }] }
    );

    expect(saved.fiftyoneCtoCateOptionsByPid).toEqual({
      "176": [{ value: "200", label: "Java" }],
      "177": [{ value: "201", label: "Vue" }]
    });
    // 重新读取（走 parseCategoryOptionsMap 解析）必须与写入一致。
    const reread = accounts.requireAccount(accountId);
    expect(reread.fiftyoneCtoCateOptionsByPid["176"]).toEqual([{ value: "200", label: "Java" }]);
    expect(reread.fiftyoneCtoCateOptionsByPid["177"]).toEqual([{ value: "201", label: "Vue" }]);
    // 未分组选项也照旧保留，供老路径降级使用。
    expect(reread.fiftyoneCtoCateOptions).toHaveLength(2);
  });

  it("drops groups whose pid is not in the current first-level options", () => {
    // 一级栏目是会变的：历史残留的分组如果不清掉，下拉里会出现选不到的幽灵选项。
    const { accounts, accountId } = setup();
    const saved = accounts.saveFiftyoneCtoOptions(
      accountId,
      [{ value: "176", label: "后端" }],
      [{ value: "200", label: "Java" }],
      { "176": [{ value: "200", label: "Java" }], "999": [{ value: "888", label: "已下线栏目" }] }
    );
    expect(saved.fiftyoneCtoCateOptionsByPid).toEqual({ "176": [{ value: "200", label: "Java" }] });
    expect(saved.fiftyoneCtoCateOptionsByPid["999"]).toBeUndefined();
  });

  it("returns an empty map when no grouping is given (legacy data degrades gracefully)", () => {
    const { accounts, accountId } = setup();
    const saved = accounts.saveFiftyoneCtoOptions(
      accountId,
      [{ value: "176", label: "后端" }],
      [{ value: "200", label: "Java" }]
    );
    expect(saved.fiftyoneCtoCateOptionsByPid).toEqual({});
    // 老数据仍要有未分组选项可用，否则二级下拉会直接退化成手填。
    expect(saved.fiftyoneCtoCateOptions).toEqual([{ value: "200", label: "Java" }]);
  });

  it("falls back to an empty map for malformed stored JSON", () => {
    const { accounts, accountId, } = setup();
    accounts.saveFiftyoneCtoOptions(accountId, [{ value: "176", label: "后端" }], [{ value: "200", label: "Java" }]);
    // 直接写坏列，模拟数据损坏：解析必须安全回退，不能抛错。
    database?.connection.prepare("UPDATE account_profiles SET fiftyone_cto_cate_options_by_pid = ? WHERE account_id = ?")
      .run("{not json", accountId);
    const account = accounts.requireAccount(accountId);
    expect(account.fiftyoneCtoCateOptionsByPid).toEqual({});
  });
});
