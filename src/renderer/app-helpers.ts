import type { WechatPublishJob, CsdnPublishJob, CnblogsPublishJob, JuejinPublishJob } from "./types";

export type PublishEntry =
  | { kind: "wechat"; job: WechatPublishJob }
  | { kind: "csdn"; job: CsdnPublishJob }
  | { kind: "cnblogs"; job: CnblogsPublishJob }
  | { kind: "juejin"; job: JuejinPublishJob };

export const byUpdatedAtDesc = (a: PublishEntry, b: PublishEntry) =>
  new Date(b.job.updatedAt).getTime() - new Date(a.job.updatedAt).getTime();

export const getPageTitle = (
  activeView: "dashboard" | "library" | "publish" | "skills" | "accounts" | "logs" | "help",
  projectsCount: number
): string =>
  activeView === "dashboard"
    ? projectsCount === 0 ? "开始创作" : "工作台"
    : activeView === "library" ? "内容库"
      : activeView === "publish" ? "发布记录"
        : activeView === "skills" ? "技能与模型"
          : activeView === "accounts" ? "账号" : activeView === "help" ? "使用帮助" : "运行日志";
