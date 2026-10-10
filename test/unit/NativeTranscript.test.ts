import { describe, expect, test } from "bun:test";
import type { OpenAIMessage } from "../../src/server/openai/index.js";
import { makeContext } from "../../src/server/session/ContextManager.js";
import { makeNativeTranscript } from "../../src/server/session/NativeTranscript.js";

const history: OpenAIMessage[] = [
  { role: "system", content: "Be concise" },
  { role: "user", content: "Read two files, then run a command" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
      { id: "call_2", type: "function", function: { name: "read", arguments: '{"path":"b"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "First file data" },
  { role: "tool", tool_call_id: "call_2", content: "Second file data" },
];

describe("Native request history", () => {
  test("keeps tool data out of instructions and links calls to parallel results", () => {
    const dict = makeNativeTranscript("Be concise", history);
    const entries = dict.transcript.entries;
    expect(entries.map((entry) => entry.role)).toEqual([
      "instructions",
      "user",
      "response",
      "tool",
      "tool",
    ]);
    expect(entries[1]?.options).toEqual({});
    expect(entries[1]?.contextOptions).toEqual({});
    expect(JSON.stringify(entries[0])).not.toContain("file data");
    const calls = entries[2]?.toolCalls as { id: string; name: string; arguments: string }[];
    expect(calls[0]?.arguments).toBe('{"path":"a"}');
    expect(calls[0]?.id).not.toBe("call_1");
    expect(entries[3]?.toolCallID).toBe(calls[0]?.id);
    expect(entries[4]?.toolCallID).toBe(calls[1]?.id);
    expect(entries[4]?.toolName).toBe("read");
  });

  test("omits the final user prompt and preserves assistant text", () => {
    const dict = makeNativeTranscript("", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Next question" },
    ]);
    expect(dict.transcript.entries).toHaveLength(3);
    expect(JSON.stringify(dict)).toContain('"text":"Hi"');
    expect(JSON.stringify(dict)).not.toContain("Next question");
  });

  test("reused client IDs across turns link to the latest call, using unique native IDs", () => {
    const dict = makeNativeTranscript("", [
      ...history,
      {
        role: "assistant",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Command result" },
    ]);
    expect(dict.transcript.entries.at(-1)?.toolName).toBe("bash");
    expect(dict.transcript.entries.at(-1)?.toolCallID).not.toBe(
      dict.transcript.entries[3]?.toolCallID,
    );
  });

  test("orphan tool results are rejected", () => {
    expect(() =>
      makeNativeTranscript("", [{ role: "tool", tool_call_id: "missing", content: "data" }]),
    ).toThrow("preceding assistant tool call");
  });

  test("native context has schemas but no JSON template or folded history", () => {
    const context = makeContext({
      messages: history,
      nativeHistory: true,
      injectToolInstructions: true,
      tools: [{ type: "function", function: { name: "read" } }],
    });
    expect(context.instructions).toContain('"name": "read"');
    expect(context.instructions).not.toContain("Conversation so far");
    expect(context.instructions).not.toContain('"tool_calls"');
    expect(context.instructions).not.toContain("First file data");
    expect(context.finalPrompt).not.toContain("Second file data");
    expect(context.finalPrompt).toContain("Continue the user's task");
  });
});
