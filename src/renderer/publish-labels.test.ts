import { describe, expect, it } from "vitest";
import { defaultCorrectionStatus, isSettledPublishStatus, publishRecordBadge, type PublishJobLike } from "./publish-labels";

const job = (status: string, statusSource?: string): PublishJobLike => ({ status, statusSource });

describe("isSettledPublishStatus", () => {
  it("终态 published / cancelled 直接归档", () => {
    expect(isSettledPublishStatus(job("published"))).toBe(true);
    expect(isSettledPublishStatus(job("cancelled"))).toBe(true);
  });

  it("系统判定 failed 仍留在待处理（需要用户人工核实）", () => {
    expect(isSettledPublishStatus(job("failed"))).toBe(false);
    expect(isSettledPublishStatus(job("failed", "system"))).toBe(false);
  });

  it("人工核实为 failed 视为已处理并归档到发布记录", () => {
    expect(isSettledPublishStatus(job("failed", "manual"))).toBe(true);
  });

  it("进行中状态（即使 system 来源）不归档", () => {
    expect(isSettledPublishStatus(job("filling", "system"))).toBe(false);
    expect(isSettledPublishStatus(job("ready_for_final_confirmation"))).toBe(false);
    expect(isSettledPublishStatus(job("needs_manual_reconciliation"))).toBe(false);
  });
});

describe("defaultCorrectionStatus", () => {
  it("失败任务默认停在 发布失败，避免 failed→failed 死循环", () => {
    expect(defaultCorrectionStatus(job("failed", "system"))).toBe("failed");
  });

  it("已取消任务默认停在 取消发布", () => {
    expect(defaultCorrectionStatus(job("cancelled"))).toBe("cancelled");
  });

  it("进行中任务默认停在 已发布（成功路径）", () => {
    expect(defaultCorrectionStatus(job("filling"))).toBe("published");
  });
});

describe("publishRecordBadge", () => {
  it("人工核实失败显示红色 已失败", () => {
    expect(publishRecordBadge(job("failed", "manual"))).toEqual({ text: "已失败", tone: "danger" });
  });

  it("取消发布显示黄色 已取消", () => {
    expect(publishRecordBadge(job("cancelled"))).toEqual({ text: "已取消", tone: "warning" });
  });

  it("发布成功显示绿色 已完成", () => {
    expect(publishRecordBadge(job("published"))).toEqual({ text: "已完成", tone: "success" });
  });
});
