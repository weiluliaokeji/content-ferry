import { describe, it, expect } from "vitest";
import { inferJuejinTags, inferJuejinCategory, JUEJIN_MAX_TAGS } from "./juejin-tags";

const POOL = [
  { id: "t-python", name: "Python" },
  { id: "t-mysql", name: "MySQL" },
  { id: "t-java", name: "Java" },
  { id: "t-ai", name: "AI" },
  { id: "t-ml", name: "机器学习" }
];

describe("inferJuejinTags", () => {
  it("按正文中出现次数排序，取相关性最高的标签", () => {
    const markdown = "Python 是门好语言。Python 适合后端开发。Python 性能不错。MySQL 用于存储数据。MySQL 很常用。";
    const result = inferJuejinTags("Python 入门", markdown, POOL);
    expect(result).toEqual(["t-python", "t-mysql"]);
  });

  it("标题命中加权，使其排在正文出现更多但仅出现在正文里的标签之前", () => {
    const markdown = "Python 与 Java 对比。Java 是一种语言。Java 应用广泛。Java 生态成熟。";
    const result = inferJuejinTags("Python 教程", markdown, POOL);
    expect(result[0]).toBe("t-python");
    expect(result).toContain("t-java");
  });

  it("正文未出现任何官方标签名时返回空数组", () => {
    expect(inferJuejinTags("无", "没有任何相关词", POOL)).toEqual([]);
  });

  it("返回数量不超过 JUEJIN_MAX_TAGS 且 id 均来自官方池", () => {
    const bigPool = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((name, i) => ({ id: `tag-${i}`, name }));
    const markdown = "Alpha Beta Gamma Delta Epsilon 都出现了";
    const result = inferJuejinTags("", markdown, bigPool);
    expect(result.length).toBeLessThanOrEqual(JUEJIN_MAX_TAGS);
    expect(result).toEqual(["tag-0", "tag-1", "tag-2"]);
  });

  it("中文标签名按子串命中并参与排序", () => {
    const pool = [{ id: "t-ml", name: "机器学习" }, { id: "t-dl", name: "深度学习" }];
    const markdown = "机器学习很有用。机器学习应用广。深度学习是分支。";
    const result = inferJuejinTags("", markdown, pool);
    expect(result[0]).toBe("t-ml");
  });
});

describe("inferJuejinCategory", () => {
  it("Docker/K8s 文章归类为后端而非被泛词带偏到人工智能", () => {
    const result = inferJuejinCategory("Docker 实战", "使用 kubernetes 部署微服务，docker 容器化，分布式架构与消息队列");
    expect(result).toBe("6809637769959178254");
  });

  it("大模型/LLM 文章归类为人工智能", () => {
    const result = inferJuejinCategory("大模型应用", "使用 llm 和 gpt 做机器学习，神经网络微调与 rag");
    expect(result).toBe("6809637773935378440");
  });

  it("无任何命中时回退到代码人生", () => {
    expect(inferJuejinCategory("", "")).toBe("6809637776263217160");
  });

  it("泛词 ai/token/prompt 降权，避免仅凭泛词压过有具体关键词的 backend", () => {
    const result = inferJuejinCategory("架构与提示工程", "系统设计需要良好架构，同时涉及 prompt 与 token 以及 ai 的应用");
    expect(result).toBe("6809637769959178254");
  });
});
