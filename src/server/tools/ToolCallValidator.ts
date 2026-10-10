import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { OpenAITool, ToolChoice } from "../openai/index.js";
import { type ParsedToolCall, ToolCallHandler } from "./ToolCallHandler.js";

export type ToolCallValidation =
  | { calls: ParsedToolCall[] | null; error: null }
  | { calls: null; error: string };

/** Validate generated calls before exposing them to a client or executing MCP tools. */
export class ToolCallValidator {
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly requiresCall: boolean;

  constructor(tools: OpenAITool[], choice?: ToolChoice) {
    this.requiresCall = choice === "required" || typeof choice === "object";
    for (const tool of tools) {
      const schema = tool.function.parameters ?? { type: "object" };
      const dialect =
        typeof schema === "object" && schema !== null
          ? ((schema as { $schema?: string }).$schema ?? "")
          : "";
      const Validator = dialect.includes("2020-12")
        ? Ajv2020
        : dialect.includes("2019-09")
          ? Ajv2019
          : Ajv;
      const ajv = new Validator({ strict: false, validateFormats: false, allErrors: true });
      this.validators.set(tool.function.name, ajv.compile(schema as object | boolean));
    }
  }

  validate(content: string, explicitCalls?: ParsedToolCall[]): ToolCallValidation {
    const calls = explicitCalls ?? ToolCallHandler.detectToolCall(content);
    if (!calls?.length) {
      if (explicitCalls === undefined && /"tool_calls"\s*:/.test(content)) {
        return { calls: null, error: "The tool_calls envelope is malformed." };
      }
      return this.requiresCall
        ? { calls: null, error: "tool_choice requires a call to a supplied function." }
        : { calls: null, error: null };
    }
    const ids = new Set<string>();
    for (const call of calls) {
      const validate = this.validators.get(call.name);
      if (!validate) return { calls: null, error: `Function '${call.name}' is not supplied.` };
      if (ids.has(call.id)) return { calls: null, error: "Tool-call IDs must be distinct." };
      ids.add(call.id);
      let args: unknown;
      try {
        args = JSON.parse(call.argumentsString);
      } catch {
        return { calls: null, error: `Arguments for '${call.name}' must be valid JSON.` };
      }
      if (!validate(args)) {
        return {
          calls: null,
          error: `Arguments for '${call.name}' do not match its schema: ${JSON.stringify(validate.errors)}`,
        };
      }
    }
    return { calls, error: null };
  }
}
