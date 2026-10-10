import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createApp } from "../../src/server/app.js";
import type { McpStdioClient } from "../../src/server/mcp/McpClient.js";
import type { OpenAIMessage, OpenAITool, ToolCall } from "../../src/server/openai/index.js";
import { PccInferenceService } from "../../src/server/pcc/PccInferenceService.js";
import type {
  InferenceService,
  InferenceStreamEvent,
} from "../../src/server/sdk/InferenceService.js";

const tools: OpenAITool[] = ["read", "bash"].map((name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
}));
const usage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };

function fakeInference(outputs: string[], finishReason = "stop", error?: Error) {
  const inputs: { instructions: string; prompt?: string }[] = [];
  const release = mock(() => {});
  let current = -1;
  const inference = {
    contextSize: 8192,
    openSession(_backend: unknown, instructions: string) {
      inputs.push({ instructions });
      return { release };
    },
    async respond(_session: unknown, prompt: string) {
      const input = inputs.at(-1);
      if (!input) throw new Error("Session not opened");
      input.prompt = prompt;
      return { content: outputs[++current] ?? "", finishReason, usage };
    },
    async *stream(_session: unknown, prompt: string): AsyncGenerator<InferenceStreamEvent> {
      const input = inputs.at(-1);
      if (!input) throw new Error("Session not opened");
      input.prompt = prompt;
      const output = outputs[++current] ?? "";
      // Split inside JSON keys and escaped strings, as real inference can.
      for (let i = 0; i < output.length; i += 3) {
        yield { kind: "delta", text: output.slice(i, i + 3) };
      }
      if (error) throw error;
      yield { kind: "done", finishReason, usage };
    },
  } as unknown as InferenceService;
  return { inference, inputs, release };
}

function request(app: ReturnType<typeof createApp>, overrides: Record<string, unknown> = {}) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({
      model: "system",
      stream: true,
      tools,
      messages: [{ role: "user", content: "Read package.json" }],
      ...overrides,
    }),
  });
}

async function chunks(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const wire = await response.text();
  expect(wire.endsWith("data: [DONE]\n\n")).toBe(true);
  const frames = wire.split("\n\n").slice(0, -1);
  expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
  for (const frame of frames) expect(frame.startsWith("data: ")).toBe(true);
  const events = frames.slice(0, -1).map((frame) => JSON.parse(frame.slice(6)));
  for (const event of events.filter((event) => !event.error)) {
    expect(event.object).toBe("chat.completion.chunk");
    expect(event.id).toBe(events[0].id);
    expect(event.created).toBe(events[0].created);
    expect(event.model).toBe(events[0].model);
  }
  expect(events[0].choices[0].delta).toEqual({ role: "assistant" });
  return events;
}

function deltas(events: Awaited<ReturnType<typeof chunks>>) {
  return events.flatMap((event) => event.choices ?? []).map((choice) => choice.delta);
}

afterEach(() => mock.restore());

describe("Chat Completions streaming tools", () => {
  for (const raw of [
    { id: "call_1", function: { name: "read", arguments: '{"path":"package.json"}' } },
    { name: "read", arguments: { path: "package.json" } },
    { id: "call_2", type: "read", arguments: { path: "package.json" } },
  ]) {
    for (const tool_calls of [raw, [raw]]) {
      for (const stream of [false, true]) {
        test(`${stream ? "streaming" : "non-streaming"}: ${JSON.stringify(tool_calls)}`, async () => {
          const fake = fakeInference([JSON.stringify({ tool_calls })]);
          const response = await request(createApp(fake), { stream });
          let calls: (ToolCall & { index?: number })[];
          if (stream) {
            const events = await chunks(response);
            expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
            expect(deltas(events).some((delta) => "content" in delta)).toBe(false);
            calls = deltas(events).flatMap((delta) => delta.tool_calls ?? []);
            expect(calls[0].index).toBe(0);
          } else {
            const body = await response.json();
            expect(body.choices[0].finish_reason).toBe("tool_calls");
            expect(body.choices[0].message.content).toBeNull();
            calls = body.choices[0].message.tool_calls;
          }
          expect(calls).toHaveLength(1);
          expect(calls[0].id).toMatch(/^call_/);
          expect(calls[0].type).toBe("function");
          expect(calls[0].function).toEqual({ name: "read", arguments: '{"path":"package.json"}' });
          expect(fake.release).toHaveBeenCalledTimes(1);
        });
      }
    }
  }

  test("multiple calls use separate indexes and JSON strings; usage follows finish", async () => {
    const argumentsObject = { command: 'printf "hello\\n"', nested: [1, { x: "}" }] };
    const fake = fakeInference(
      [
        JSON.stringify({
          tool_calls: [
            { id: "call_1", name: "read", arguments: { path: "package.json" } },
            { id: "call_2", function: { name: "bash", arguments: argumentsObject } },
          ],
        }),
      ],
      "length",
    );
    const events = await chunks(
      await request(createApp(fake), { stream_options: { include_usage: true } }),
    );
    const calls = deltas(events).flatMap((delta) => delta.tool_calls ?? []);
    expect(calls.map((call) => call.index)).toEqual([0, 1]);
    expect(calls.map((call) => call.id)).toEqual(["call_1", "call_2"]);
    expect(JSON.parse(calls[1].function.arguments)).toEqual(argumentsObject);
    expect(events.at(-2).choices[0].finish_reason).toBe("tool_calls");
    expect(events.at(-1).choices).toEqual([]);
    expect(events.at(-1).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });

  for (const availableTools of [tools, undefined, []]) {
    test(`ordinary text works with tools=${JSON.stringify(availableTools)}`, async () => {
      const fake = fakeInference(["Hello world"]);
      const events = await chunks(await request(createApp(fake), { tools: availableTools }));
      expect(
        deltas(events)
          .map((delta) => delta.content ?? "")
          .join(""),
      ).toBe("Hello world");
      expect(events.at(-1).choices[0].finish_reason).toBe("stop");
      if (!availableTools?.length) {
        expect(deltas(events).filter((delta) => delta.content)).toHaveLength(4);
      }
    });
  }

  for (const output of [
    '{"tool_calls":',
    '{"tool_calls":{"name":"read","arguments":"{bad}"}}',
    '{"tool_calls":{"name":"unknown","arguments":{}}}',
  ]) {
    test(`invalid output remains text: ${output}`, async () => {
      const events = await chunks(await request(createApp(fakeInference([output]))));
      expect(
        deltas(events)
          .map((delta) => delta.content ?? "")
          .join(""),
      ).toBe(output);
      expect(events.at(-1).choices[0].finish_reason).toBe("stop");
    });
  }

  for (const stream of [false, true]) {
    test(`tool_choice none disables detection and instructions (stream=${stream})`, async () => {
      const output = '{"tool_calls":{"name":"read","arguments":{}}}';
      const fake = fakeInference([output]);
      const response = await request(createApp(fake), { stream, tool_choice: "none" });
      const content = stream
        ? deltas(await chunks(response))
            .map((delta) => delta.content ?? "")
            .join("")
        : (await response.json()).choices[0].message.content;
      expect(content).toBe(output);
      expect(fake.inputs[0].instructions).not.toContain("Tool Calling Format");
    });
  }

  test("forced choice restricts tools and asks the model to call the selected function", async () => {
    const fake = fakeInference(['{"tool_calls":{"name":"read","arguments":{}}}']);
    const events = await chunks(
      await request(createApp(fake), {
        tool_choice: { type: "function", function: { name: "read" } },
      }),
    );
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(fake.inputs[0].instructions).toContain("You must call the function read.");
    expect(fake.inputs[0].instructions).not.toContain('"name": "bash"');
  });

  test("auto accepts calls; forced choice does not surface a different tool", async () => {
    const output = '{"tool_calls":{"name":"bash","arguments":{"command":"pwd"}}}';
    const fake = fakeInference([output, output]);
    const app = createApp(fake);
    const auto = await chunks(await request(app, { tool_choice: "auto" }));
    expect(auto.at(-1).choices[0].finish_reason).toBe("tool_calls");
    const forced = await chunks(
      await request(app, {
        tool_choice: { type: "function", function: { name: "read" } },
      }),
    );
    expect(forced.at(-1).choices[0].finish_reason).toBe("stop");
    expect(
      deltas(forced)
        .map((delta) => delta.content ?? "")
        .join(""),
    ).toBe(output);
  });

  test("text truncation retains the backend's length finish reason", async () => {
    const events = await chunks(
      await request(createApp(fakeInference(["Partial answer"], "length"))),
    );
    expect(events.at(-1).choices[0].finish_reason).toBe("length");
  });

  test("required selection adds instructions; unknown forced tool returns 400", async () => {
    const fake = fakeInference(["Hello"]);
    const app = createApp(fake);
    await chunks(await request(app, { tool_choice: "required" }));
    expect(fake.inputs[0].instructions).toContain("must call at least one");
    expect(
      (await request(app, { tool_choice: { type: "function", function: { name: "unknown" } } }))
        .status,
    ).toBe(400);
    expect(fake.inputs).toHaveLength(1);
  });

  test("PCC uses the same streaming normalization", async () => {
    const pcc = spyOn(PccInferenceService, "stream").mockImplementation(async function* () {
      yield { kind: "delta", text: '{"tool_calls":{"name":"read","arguments":{}}}' };
      yield { kind: "done", finishReason: "stop", usage };
    });
    const events = await chunks(await request(createApp(fakeInference([])), { model: "pcc" }));
    expect(events[0].model).toBe("pcc");
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(pcc).toHaveBeenCalledTimes(1);
  });

  test("MCP-injected tools execute on the server and stream the followup answer", async () => {
    const fake = fakeInference([
      '{"tool_calls":{"name":"read","arguments":{}}}',
      "Scripts: build, test",
    ]);
    const callTool = mock(async () => "package contents");
    const mcp = { listTools: async () => tools, callTool } as unknown as McpStdioClient;
    const events = await chunks(
      await request(createApp({ ...fake, mcpClients: [mcp] }), { tools: undefined }),
    );
    expect(callTool).toHaveBeenCalledWith("read", "{}");
    expect(
      deltas(events)
        .map((delta) => delta.content ?? "")
        .join(""),
    ).toBe("Scripts: build, test");
    expect(events.at(-1).choices[0].finish_reason).toBe("stop");
  });

  test("stream errors end with an error and DONE, without executing partial output", async () => {
    const fake = fakeInference(
      ['{"tool_calls":{"name":"read","arguments":{}}}'],
      "stop",
      new Error("Inference failed"),
    );
    const events = await chunks(await request(createApp(fake)));
    expect(events.at(-1).error).toBeDefined();
    expect(deltas(events)).toEqual([{ role: "assistant" }]);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  test("auth still protects streaming requests", async () => {
    const fake = fakeInference([]);
    const response = await request(createApp({ ...fake, token: "different-token" }));
    expect(response.status).toBe(401);
    expect(fake.inputs).toHaveLength(0);
  });

  test("read → bash → read across requests preserves tool results and history", async () => {
    const fake = fakeInference([
      '{"tool_calls":{"name":"read","arguments":{"path":"package.json"}}}',
      '{"tool_calls":[{"name":"bash","arguments":{"command":"pnpm run build"}}]}',
      '{"tool_calls":{"function":{"name":"read","arguments":"{\\"path\\":\\"dist/server/app.js\\"}"}}}',
      "Build succeeded; the compiled file exists.",
    ]);
    const app = createApp(fake);
    const messages: OpenAIMessage[] = [
      { role: "user", content: "Read package.json, build, then read the compiled file." },
    ];
    const results = [
      '{"scripts":{"build":"tsc --build"}}',
      "Build succeeded",
      "Compiled file contents",
    ];
    for (const [index, name] of ["read", "bash", "read"].entries()) {
      const events = await chunks(await request(app, { messages }));
      const calls = deltas(events).flatMap((delta) => delta.tool_calls ?? []);
      expect(calls[0].function.name).toBe(name);
      expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: calls.map(({ index: _index, ...call }) => call),
      });
      messages.push({ role: "tool", tool_call_id: calls[0].id, content: results[index] ?? "" });
      if (index > 0) expect(fake.inputs[index].prompt).toContain(results[index - 1] ?? "");
    }
    const final = await chunks(await request(app, { messages }));
    expect(final.at(-1).choices[0].finish_reason).toBe("stop");
    expect(fake.inputs[3].prompt).toContain(results[2] ?? "");
    expect(fake.inputs[3].instructions).toContain("Assistant called tool(s): bash(");
    expect(fake.inputs[3].instructions).toContain(results[0] ?? "");
    expect(fake.release).toHaveBeenCalledTimes(4);
  });
});
