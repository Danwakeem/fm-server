import { type OpenAIMessage, messageText } from "../openai/index.js";

/** Convert OpenAI history to Foundation Models entries without promoting tool data to instructions. */
export function makeNativeTranscript(instructions: string, messages: OpenAIMessage[]) {
  const text = (value: string) => ({ type: "text", id: crypto.randomUUID(), text: value });
  const entries: Record<string, unknown>[] = [
    {
      id: crypto.randomUUID(),
      role: "instructions",
      contents: instructions ? [text(instructions)] : [],
    },
  ];
  const calls = new Map<string, { id: string; name: string }>();
  // A trailing tool result is history; a trailing user message is the next prompt.
  const history = messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
  for (const message of history) {
    if (message.role === "system") continue;
    const content = messageText(message);
    const entry: Record<string, unknown> = {
      id: crypto.randomUUID(),
      role: message.role === "assistant" ? "response" : message.role,
      contents: content !== null ? [text(content)] : [],
    };
    if (message.role === "user") {
      entry.options = {};
      entry.contextOptions = {};
    }
    if (message.role === "assistant") entry.assets = [];
    if (message.tool_calls?.length) {
      entry.toolCalls = message.tool_calls.map((call) => {
        const id = crypto.randomUUID();
        calls.set(call.id, { id, name: call.function.name });
        return { id, name: call.function.name, arguments: call.function.arguments };
      });
    }
    if (message.role === "tool") {
      const call = calls.get(message.tool_call_id ?? "");
      if (!call) throw new Error("Tool result must reference a preceding assistant tool call.");
      entry.id = call.id;
      entry.toolCallID = call.id;
      entry.toolName = call.name;
    }
    entries.push(entry);
  }
  return { version: "1.1", type: "FoundationModels.Transcript", transcript: { entries } };
}
