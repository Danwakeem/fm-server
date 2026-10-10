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
  const inputs: { instructions: string; prompt?: string; transcript?: Record<string, unknown> }[] =
    [];
  const prompts: string[] = [];
  const release = mock(() => {});
  let current = -1;
  const inference = {
    contextSize: 8192,
    openSession(_backend: unknown, instructions: string) {
      inputs.push({ instructions });
      return { release };
    },
    async openSessionFromTranscript(transcript: {
      transcript: { entries: { contents: { text: string }[] }[] };
    }) {
      inputs.push({
        instructions: transcript.transcript.entries[0]?.contents[0]?.text ?? "",
        transcript,
      });
      return { release };
    },
    async respond(_session: unknown, prompt: string) {
      prompts.push(prompt);
      const input = inputs.at(-1);
      if (!input) throw new Error("Session not opened");
      input.prompt = prompt;
      return { content: outputs[++current] ?? "", finishReason, usage };
    },
    async *stream(_session: unknown, prompt: string): AsyncGenerator<InferenceStreamEvent> {
      prompts.push(prompt);
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
  return { inference, inputs, prompts, release };
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
    test(`invalid output is retried then errors: ${output}`, async () => {
      const fake = fakeInference([output, output]);
      const events = await chunks(await request(createApp(fake)));
      expect(events.at(-1).error.type).toBe("server_error");
      expect(events.at(-1).error.message).toContain("after one corrective retry");
      expect(deltas(events)).toEqual([{ role: "assistant" }]);
      expect(fake.prompts).toHaveLength(2);
      expect(fake.release).toHaveBeenCalledTimes(1);
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
    const fake = fakeInference([output, output, output]);
    const app = createApp(fake);
    const auto = await chunks(await request(app, { tool_choice: "auto" }));
    expect(auto.at(-1).choices[0].finish_reason).toBe("tool_calls");
    const forced = await chunks(
      await request(app, {
        tool_choice: { type: "function", function: { name: "read" } },
      }),
    );
    expect(forced.at(-1).error.message).toContain("after one corrective retry");
    expect(deltas(forced)).toEqual([{ role: "assistant" }]);
  });

  test("text truncation retains the backend's length finish reason", async () => {
    const events = await chunks(
      await request(createApp(fakeInference(["Partial answer"], "length"))),
    );
    expect(events.at(-1).choices[0].finish_reason).toBe("length");
  });

  test("required selection adds instructions; unknown forced tool returns 400", async () => {
    const fake = fakeInference(["Hello", '{"tool_calls":{"name":"read","arguments":{}}}']);
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

  for (const stream of [false, true]) {
    test(`one corrective retry can recover an invented tool (stream=${stream})`, async () => {
      const fake = fakeInference([
        '{"tool_calls":{"function":"list","arguments":[]}}',
        "Scripts: build, test",
      ]);
      const response = await request(createApp(fake), {
        stream,
        stream_options: { include_usage: true },
      });
      if (stream) {
        const events = await chunks(response);
        expect(
          deltas(events)
            .map((delta) => delta.content ?? "")
            .join(""),
        ).toBe("Scripts: build, test");
        expect(events.at(-2).choices[0].finish_reason).toBe("stop");
        expect(events.at(-1).usage.total_tokens).toBe(60);
      } else {
        const body = await response.json();
        expect(body.choices[0].message.content).toBe("Scripts: build, test");
        expect(body.usage.total_tokens).toBe(60);
      }
      expect(fake.prompts).toHaveLength(2);
      expect(fake.prompts[1]).toContain("not supplied");
      expect(fake.release).toHaveBeenCalledTimes(1);
    });

    test(`failed recovery returns an explicit error (stream=${stream})`, async () => {
      const output = '{"tool_calls":{"name":"unknown","arguments":{}}}';
      const fake = fakeInference([output, output]);
      const response = await request(createApp(fake), { stream });
      if (stream) {
        const events = await chunks(response);
        expect(events.at(-1).error.message).toContain("after one corrective retry");
      } else {
        expect(response.status).toBe(500);
        expect((await response.json()).error.type).toBe("server_error");
      }
      expect(fake.prompts).toHaveLength(2);
    });
  }

  test("native final-answer metadata preserves literal JSON text", async () => {
    const output = '{"tool_calls": "documentation example"}';
    const fake = fakeInference([]);
    spyOn(fake.inference, "stream").mockImplementation(async function* () {
      yield { kind: "delta", text: output };
      yield { kind: "done", finishReason: "stop", usage, toolCalls: [] };
    });
    const events = await chunks(await request(createApp(fake)));
    expect(events.at(-1).choices[0].finish_reason).toBe("stop");
    expect(
      deltas(events)
        .map((delta) => delta.content ?? "")
        .join(""),
    ).toBe(output);
  });

  test("required selection without tools is rejected", async () => {
    const fake = fakeInference([]);
    expect((await request(createApp(fake), { tools: [], tool_choice: "required" })).status).toBe(
      400,
    );
    expect(fake.inputs).toHaveLength(0);
  });

  test("native decoding failures get exactly one corrective retry", async () => {
    const fake = fakeInference(["Scripts: build, test"]);
    const initial = spyOn(fake.inference, "stream").mockImplementation(async function* () {
      yield { kind: "delta", text: '{"tool_calls":' };
      throw { kind: "decodingFailure", message: "Incomplete structured output" };
    });
    const events = await chunks(await request(createApp(fake)));
    expect(events.at(-1).choices[0].finish_reason).toBe("stop");
    expect(initial).toHaveBeenCalledTimes(1);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain("Incomplete structured output");
  });

  test("schema-invalid arguments are corrected before emitting a call", async () => {
    const fake = fakeInference([
      '{"tool_calls":{"name":"read","arguments":{}}}',
      '{"tool_calls":{"name":"read","arguments":{"path":"package.json"}}}',
    ]);
    const events = await chunks(
      await request(createApp(fake), {
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              parameters: {
                type: "object",
                required: ["path"],
                properties: { path: { type: "string" } },
              },
            },
          },
        ],
      }),
    );
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(fake.prompts[1]).toContain("do not match");
    expect(deltas(events).flatMap((delta) => delta.tool_calls ?? [])).toHaveLength(1);
  });

  test("invalid client schemas and orphan results are rejected before opening inference", async () => {
    const fake = fakeInference([]);
    const app = createApp(fake);
    expect(
      (
        await request(app, {
          tools: [{ function: { name: "read", parameters: { type: "banana" } } }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app, {
          messages: [{ role: "tool", tool_call_id: "missing", content: "data" }],
        })
      ).status,
    ).toBe(400);
    expect(fake.inputs).toHaveLength(0);
  });

  test("PCC recovery uses the same validator without native transcripts", async () => {
    const first = spyOn(PccInferenceService, "stream").mockImplementation(async function* () {
      yield { kind: "delta", text: '{"tool_calls":{"name":"invented","arguments":{}}}' };
      yield { kind: "done", finishReason: "stop", usage };
    });
    const retry = spyOn(PccInferenceService, "respond").mockResolvedValue({
      content: "Scripts: build, test",
      finishReason: "stop",
      usage,
    });
    const events = await chunks(await request(createApp(fakeInference([])), { model: "pcc" }));
    expect(events.at(-1).choices[0].finish_reason).toBe("stop");
    expect(first).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
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
      if (index > 0)
        expect(JSON.stringify(fake.inputs[index].transcript)).toContain(
          JSON.stringify(results[index - 1] ?? "").slice(1, -1),
        );
    }
    const final = await chunks(await request(app, { messages }));
    expect(final.at(-1).choices[0].finish_reason).toBe("stop");
    expect(JSON.stringify(fake.inputs[3].transcript)).toContain(results[2] ?? "");
    expect(JSON.stringify(fake.inputs[3].transcript)).toContain('"name":"bash"');
    expect(fake.inputs[3].instructions).not.toContain("Conversation so far");
    expect(JSON.stringify(fake.inputs[3].transcript)).toContain("scripts");
    expect(fake.release).toHaveBeenCalledTimes(4);
  });
});
