import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { LanguageModelSession, type getNativeBindings } from "javascript-apple-fm-sdk";
import { InferenceService } from "../../src/server/sdk/InferenceService.js";
import { ModelProvider } from "../../src/server/sdk/ModelProvider.js";
import { makeNativeTranscript } from "../../src/server/session/NativeTranscript.js";

// Use the SDK's own mock-binding hook; no Apple model or native binary is needed.
const bindings = (await import(
  new URL("./ffi/native.js", import.meta.resolve("javascript-apple-fm-sdk")).href
)) as {
  setNativeBindingsForTests(value: ReturnType<typeof getNativeBindings> | null): void;
};
let output: Record<string, unknown>;
let restored: Record<string, unknown>;
let schemaPointer: number;
let pointer: number;
let cancelCallback: (() => void) | undefined;
const release = mock((_pointer: number) => {});
const cancel = mock((_pointer: number) => cancelCallback?.());
const choices = mock((_property: number, _values: string[], _wrapped: boolean) => {});
const minimum = mock((_property: number, _count: number) => {});
const createFromTranscript = mock(
  (_transcript: number, _model: number, _tools: number[]) => ++pointer,
);

beforeEach(() => {
  pointer = 100;
  output = { tool_calls: [{ name: "read", arguments: '{"path":"package.json"}' }], answer: "" };
  cancelCallback = undefined;
  bindings.setNativeBindingsForTests({
    fmRelease: release,
    fmTaskCancel: cancel,
    languageModelSessionCreateFromSystemLanguageModel: () => ++pointer,
    languageModelSessionCreateFromTranscript: createFromTranscript,
    transcriptCreateFromJSONString: (json: string) => {
      restored = JSON.parse(json);
      return ++pointer;
    },
    generationSchemaCreate: () => {
      schemaPointer = ++pointer;
      return schemaPointer;
    },
    generationSchemaPropertyCreate: () => ++pointer,
    generationSchemaAddProperty: () => {},
    generationSchemaAddReferenceSchema: () => {},
    generationSchemaPropertyAddMaxItemsGuide: () => {},
    generationSchemaPropertyAddAnyOfGuide: choices,
    generationSchemaPropertyAddMinItemsGuide: minimum,
    composedPromptInitialize: () => ++pointer,
    composedPromptAddText: () => {},
    languageModelSessionRespondWithSchema: (
      _session: number,
      _prompt: number,
      _schema: number,
      _options: string,
      callback: (code: number, content: number, error: string | null) => void,
    ) => {
      const task = ++pointer;
      if (cancelCallback) cancelCallback = () => callback(1, 0, "Canceled");
      else queueMicrotask(() => callback(0, ++pointer, null));
      return task;
    },
    generatedContentGetJSONString: () => JSON.stringify(output),
  } as unknown as ReturnType<typeof getNativeBindings>);
  spyOn(ModelProvider, "create").mockReturnValue({
    sdkModel: { ptr: 10 },
    tokenCountForPrompt: async () => 4,
    tokenCountForResponse: async () => 5,
  } as unknown as ModelProvider);
});

afterEach(() => {
  bindings.setNativeBindingsForTests(null);
  mock.restore();
  release.mockClear();
  cancel.mockClear();
  choices.mockClear();
  minimum.mockClear();
  createFromTranscript.mockClear();
});

const tools = [{ type: "function" as const, function: { name: "read" } }];

describe("SDK guided tool turns", () => {
  test("restores native history, normalizes guided calls, and releases transcript/schema/session", async () => {
    const inference = InferenceService.create();
    const dict = makeNativeTranscript("Be concise", [
      { role: "user", content: "Read package.json" },
    ]);
    const session = await inference.openSessionFromTranscript(dict);
    const sessionPointer = session.ptr;
    expect(createFromTranscript).toHaveBeenCalledTimes(1);
    expect(restored).toEqual(dict);
    const result = await inference.respond(session, "Read package.json", { tools });
    const calls = JSON.parse(result.content).tool_calls;
    expect(calls[0].id).toMatch(/^call_/);
    expect(calls[0].function).toEqual({ name: "read", arguments: '{"path":"package.json"}' });
    expect(choices).toHaveBeenCalledWith(expect.any(Number), ["read"], false);
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 5, totalTokens: 9 });
    expect(release.mock.calls.filter(([ptr]) => ptr === schemaPointer)).toHaveLength(1);
    session.release();
    session.release();
    expect(release.mock.calls.filter(([ptr]) => ptr === sessionPointer)).toHaveLength(1);
  });

  test("a guided final answer is returned as text, without the internal schema", async () => {
    output = { tool_calls: [], answer: "Scripts: build, test" };
    const inference = InferenceService.create();
    const session = new LanguageModelSession();
    try {
      expect((await inference.respond(session, "Continue", { tools })).content).toBe(
        "Scripts: build, test",
      );
    } finally {
      session.release();
    }
  });

  test("multiple guided calls remain separate", async () => {
    output = {
      tool_calls: [
        { name: "read", arguments: '{"path":"a"}' },
        { name: "read", arguments: '{"path":"b"}' },
      ],
      answer: "",
    };
    const inference = InferenceService.create();
    const session = new LanguageModelSession();
    try {
      const result = await inference.respond(session, "Read both", {
        tools,
        requireToolCall: true,
      });
      const calls = JSON.parse(result.content).tool_calls;
      expect(calls).toHaveLength(2);
      expect(calls[0].id).not.toBe(calls[1].id);
      expect(minimum).toHaveBeenCalledWith(expect.any(Number), 1);
    } finally {
      session.release();
    }
  });

  for (const invalid of [
    { tool_calls: [{ name: "read" }], answer: "" },
    { tool_calls: "read", answer: "" },
  ]) {
    test(`structured decoding failure can be recovered: ${JSON.stringify(invalid)}`, async () => {
      output = invalid;
      const inference = InferenceService.create();
      const session = new LanguageModelSession();
      try {
        await expect(inference.respond(session, "Read", { tools })).rejects.toMatchObject({
          kind: "decodingFailure",
        });
      } finally {
        session.release();
      }
      expect(release.mock.calls.filter(([ptr]) => ptr === schemaPointer)).toHaveLength(1);
    });
  }

  test("aborting guided generation cancels the native task and cleans up", async () => {
    cancelCallback = () => {};
    const inference = InferenceService.create();
    const session = new LanguageModelSession();
    const abort = new AbortController();
    const pending = inference.respond(session, "Read", { tools }, abort.signal);
    abort.abort();
    try {
      await expect(pending).rejects.toBeDefined();
    } finally {
      session.release();
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release.mock.calls.filter(([ptr]) => ptr === schemaPointer)).toHaveLength(1);
  });
});
