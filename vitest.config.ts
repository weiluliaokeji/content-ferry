import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // 全仓 35+ 个测试文件并行 + Windows CI 2 核 runner 会让真实磁盘 IO / resvg
    // 光栅化这类重型用例远超 vitest 默认 5s 预算（v0.1.4 release 两次挂在
    // create-server 的 SVG 预览用例上；本地全量跑也偶发 content-source /
    // skill-registry 用例超时，隔离重跑即通过）。把全局单用例预算放宽到 15s，
    // 个别重型用例再在 it(...) 第三参数里显式加长。
    testTimeout: 15_000
  }
});
