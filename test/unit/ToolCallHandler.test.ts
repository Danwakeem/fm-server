import { describe, expect, test } from "bun:test";
import { ToolCallHandler } from "../../src/server/tools/ToolCallHandler.js";

describe("ToolCallHandler normalization", () => {
  for (const call of [
    { name: "read", arguments: { path: "package.json" } },
    { function: { name: "read", arguments: '{"path":"package.json"}' } },
    { function: "read", arguments: { path: "package.json" } },
    { type: "read", arguments: { path: "package.json" } },
  ]) {
    for (const shape of [call, [call]]) {
      test(`normalizes ${JSON.stringify(shape)}`, () => {
        const calls = ToolCallHandler.detectToolCall(JSON.stringify({ tool_calls: shape }));
        expect(calls).toHaveLength(1);
        expect(calls?.[0]?.id).toMatch(/^call_/);
        expect(calls?.[0]?.name).toBe("read");
        expect(calls?.[0]?.argumentsString).toBe('{"path":"package.json"}');
      });
    }
  }

  test("preserves IDs, escaped arguments, fences and surrounding prose", () => {
    const args = { command: 'printf "{hello}\\n"', nested: { values: [1, 2] } };
    const envelope = JSON.stringify({
      tool_calls: [{ id: "call_1", function: { name: "bash", arguments: JSON.stringify(args) } }],
    });
    for (const text of [envelope, `\`\`\`json\n${envelope}\n\`\`\``, `Before ${envelope} after`]) {
      expect(ToolCallHandler.detectToolCall(text)).toEqual([
        { id: "call_1", name: "bash", argumentsString: JSON.stringify(args) },
      ]);
    }
  });

  test("keeps empty and plain-string argument compatibility", () => {
    for (const [args, expected] of [
      [undefined, "{}"],
      ["", "{}"],
      ["hello", '{"value":"hello"}'],
    ]) {
      expect(
        ToolCallHandler.detectToolCall(
          JSON.stringify({ tool_calls: { name: "read", arguments: args } }),
        )?.[0]?.argumentsString,
      ).toBe(expected);
    }
  });

  test("retains the existing missing-array-bracket repair", () => {
    expect(
      ToolCallHandler.detectToolCall(
        '{"tool_calls":[{"id":"call_1","function":"read","arguments":{}}}',
      )?.[0]?.name,
    ).toBe("read");
  });

  for (const text of [
    "Just text",
    '{"tool_calls":',
    '{"tool_calls":[]}',
    '{"tool_calls":null}',
    '{"tool_calls":{"arguments":{}}}',
    '{"tool_calls":{"name":""}}',
    '{"tool_calls":{"name":"read","arguments":"{broken}"}}',
    '{"tool_calls":[{"name":"read"},null]}',
  ]) {
    test(`does not execute malformed output: ${text}`, () => {
      expect(ToolCallHandler.detectToolCall(text)).toBeNull();
    });
  }
});
