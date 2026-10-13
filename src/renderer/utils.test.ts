import { describe, expect, it } from "vitest";
import { skillUsesSameConnectionAsWriter } from "./utils";

describe("skillUsesSameConnectionAsWriter", () => {
  it("uses the writing skill connection when the review skill inherits it", () => {
    expect(skillUsesSameConnectionAsWriter(
      { provider: "custom:review", providerInherited: true },
      { provider: "custom:writer" }
    )).toBe(true);
  });

  it("reports a separately configured review connection", () => {
    expect(skillUsesSameConnectionAsWriter(
      { provider: "custom:review", providerInherited: false },
      { provider: "custom:writer" }
    )).toBe(false);
  });

  it("treats an unset connection as the default OpenAI Codex connection", () => {
    expect(skillUsesSameConnectionAsWriter(
      { provider: null, providerInherited: false },
      { provider: "openai_codex" }
    )).toBe(true);
  });
});
