import { describe, expect, test } from "bun:test";
import type { OpenAITool } from "../../src/server/openai/index.js";
import { ToolCallValidator } from "../../src/server/tools/ToolCallValidator.js";

const parameters = {
  type: "object",
  required: ["path"],
  additionalProperties: false,
  properties: { path: { type: "string", minLength: 1 } },
};
const tool: OpenAITool = { type: "function", function: { name: "read", parameters } };
const call = (args: unknown) => JSON.stringify({ tool_calls: { name: "read", arguments: args } });

describe("ToolCallValidator", () => {
  test("validates schemas without coercing or dropping arguments", () => {
    const validator = new ToolCallValidator([tool]);
    const result = validator.validate(call({ path: "package.json" }));
    expect(result.error).toBeNull();
    expect(result.calls?.[0]?.argumentsString).toBe('{"path":"package.json"}');
    for (const args of [{}, { path: 4 }, { path: "" }, { path: "a", extra: 1 }, null]) {
      expect(validator.validate(call(args)).error).toContain("do not match");
    }
  });

  test("normal text is valid for auto; required demands a call", () => {
    expect(new ToolCallValidator([tool], "auto").validate("Scripts: build, test").error).toBeNull();
    expect(
      new ToolCallValidator([tool], "required").validate("Scripts: build, test").error,
    ).toContain("requires");
  });

  test("rejects invented tools, broken JSON and duplicate IDs", () => {
    const validator = new ToolCallValidator([tool]);
    expect(validator.validate('{"tool_calls":{"function":"list","arguments":[]}}').error).toContain(
      "not supplied",
    );
    expect(validator.validate('{"tool_calls":').error).toContain("malformed");
    const calls = [1, 2].map(() => ({ id: "duplicate", name: "read", arguments: { path: "a" } }));
    expect(validator.validate(JSON.stringify({ tool_calls: calls })).error).toContain("distinct");
  });

  for (const dialect of [
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ]) {
    test(`supports ${dialect}`, () => {
      const validator = new ToolCallValidator([
        { ...tool, function: { name: "read", parameters: { ...parameters, $schema: dialect } } },
      ]);
      expect(validator.validate(call({ path: "a" })).error).toBeNull();
      expect(validator.validate(call({ path: 1 })).error).not.toBeNull();
    });
  }

  test("a guided final answer containing literal tool JSON stays text", () => {
    const validator = new ToolCallValidator([tool]);
    const content = '{"tool_calls": "an example field, not a requested tool"}';
    expect(validator.validate(content, [])).toEqual({ calls: null, error: null });
    expect(new ToolCallValidator([tool], "required").validate(content, []).error).toContain(
      "requires",
    );
  });

  test("invalid client schemas fail at construction", () => {
    expect(
      () =>
        new ToolCallValidator([
          { ...tool, function: { name: "read", parameters: { type: "banana" } } },
        ]),
    ).toThrow();
  });
});
