// ============================================================================
// InferenceService.ts — In-process javascript-apple-fm-sdk adapter for chat inference.
// ============================================================================

import {
  LanguageModelSession,
  Transcript,
  generable,
  getNativeBindings,
  guide,
} from "javascript-apple-fm-sdk";
import { z } from "zod";
import type { ModelAvailability } from "../backend/ModelAvailability.js";
import type { ModelBackend } from "../backend/ModelBackend.js";
import { FinishReason, FinishReasonResolver } from "../chat/FinishReasonResolver.js";
import { AfmError } from "../errors/AfmError.js";
import type { OpenAITool } from "../openai/index.js";
import type { ParsedToolCall } from "../tools/ToolCallHandler.js";
import { type OpenAIGenerationParams, toGenerationOptions } from "./GenerationMapper.js";
import { ModelProvider } from "./ModelProvider.js";
import { SdkErrorMapper } from "./SdkErrorMapper.js";

export interface InferenceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface InferenceRespondResult {
  content: string;
  finishReason: string;
  usage: InferenceUsage;
  /** Present for guided generation; an empty list marks an explicit final answer. */
  toolCalls?: ParsedToolCall[];
}

export type InferenceStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done"; finishReason: string; usage: InferenceUsage; toolCalls?: ParsedToolCall[] };

export interface InferenceGenerationParams extends OpenAIGenerationParams {
  tools?: OpenAITool[];
  requireToolCall?: boolean;
}

export class InferenceService {
  private readonly provider: ModelProvider;

  private constructor(provider: ModelProvider) {
    this.provider = provider;
  }

  static create(): InferenceService {
    return new InferenceService(ModelProvider.create());
  }

  get availability(): ModelAvailability {
    return this.provider.availability;
  }

  get contextSize(): number {
    return this.provider.contextSize;
  }

  async tokenCountForPrompt(text: string, instructions?: string): Promise<number> {
    return this.provider.tokenCountForPrompt(text, instructions);
  }

  openSession(backend: ModelBackend, instructions?: string): LanguageModelSession {
    return new LanguageModelSession({
      instructions,
      model: this.provider.sdkModel,
    });
  }

  async openSessionFromTranscript(dict: Record<string, unknown>): Promise<LanguageModelSession> {
    const transcript = await Transcript.fromDict(dict);
    try {
      return LanguageModelSession.fromTranscript(transcript, { model: this.provider.sdkModel });
    } finally {
      getNativeBindings().fmRelease(transcript.sessionPtr);
    }
  }

  async respond(
    session: LanguageModelSession,
    prompt: string,
    params?: InferenceGenerationParams,
    signal?: AbortSignal,
  ): Promise<InferenceRespondResult> {
    const options = toGenerationOptions(params);

    // shortcut: eight guided calls per turn, raise the limit after testing larger batches.
    const decision = params?.tools?.length
      ? generable(
          z.object({
            tool_calls: guide(
              z
                .array(
                  z.object({
                    name: guide(z.string(), {
                      anyOf: params.tools.map((tool) => tool.function.name),
                    }),
                    arguments: guide(
                      z.string(),
                      "Arguments as a JSON object encoded as a string, matching the selected function's schema.",
                    ),
                  }),
                )
                .max(8),
              {
                minItems: params.requireToolCall ? 1 : 0,
                maxItems: 8,
                description:
                  "Functions needed next. Empty when the user can be answered from existing results.",
              },
            ),
            answer: guide(
              z.string(),
              "The answer to the user when tool_calls is empty; otherwise an empty string.",
            ),
          }),
          "NextAssistantTurn",
        )
      : undefined;

    try {
      const output = await session.respond(prompt, { options, generating: decision, signal });
      let content: string;
      let toolCalls: ParsedToolCall[] | undefined;
      if (decision && typeof output !== "string") {
        const value = decision.parse(output);
        toolCalls = value.tool_calls.map((call) => ({
          id: `call_${crypto.randomUUID()}`,
          name: call.name,
          argumentsString: call.arguments.trim() ? call.arguments : "{}",
        }));
        content = toolCalls.length
          ? JSON.stringify({
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                function: { name: call.name, arguments: call.argumentsString },
              })),
            })
          : value.answer;
      } else if (typeof output === "string") {
        content = output;
      } else {
        throw new Error("Expected text response from LanguageModelSession");
      }
      if (typeof content !== "string") {
        throw new Error("Expected text response from LanguageModelSession");
      }

      const promptTokens = await this.provider.tokenCountForPrompt(prompt);
      const completionTokens = await this.provider.tokenCountForResponse(
        typeof output === "string" ? output : output.toJSON(),
      );
      const finishReason = FinishReason.openAIValue(
        FinishReasonResolver.resolve({
          hasToolCalls: (toolCalls?.length ?? 0) > 0,
          completionTokens,
          maxTokens: params?.maxTokens,
        }),
      );

      return {
        content,
        toolCalls,
        finishReason,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
    } catch (err) {
      throw mapInferenceError(err);
    } finally {
      const schema = decision?.generationSchema();
      schema?.release();
      for (const nested of schema?.nestedSchemas ?? []) nested.release();
    }
  }

  async *stream(
    session: LanguageModelSession,
    prompt: string,
    params?: InferenceGenerationParams,
    signal?: AbortSignal,
  ): AsyncGenerator<InferenceStreamEvent, void, void> {
    if (params?.tools?.length) {
      const result = await this.respond(session, prompt, params, signal);
      yield { kind: "delta", text: result.content };
      yield {
        kind: "done",
        finishReason: result.finishReason,
        usage: result.usage,
        toolCalls: result.toolCalls,
      };
      return;
    }
    const options = toGenerationOptions(params);
    let previousSnapshot = "";
    let completionTokens = 0;

    try {
      for await (const snapshot of session.streamResponse(prompt, options)) {
        if (signal?.aborted) {
          throw new Error("Request aborted");
        }

        const delta = snapshot.slice(previousSnapshot.length);
        previousSnapshot = snapshot;

        if (delta.length > 0) {
          yield { kind: "delta", text: delta };
        }
      }

      completionTokens = await this.provider.tokenCountForResponse(previousSnapshot);
      const finishReason = FinishReason.openAIValue(
        FinishReasonResolver.resolve({
          hasToolCalls: false,
          completionTokens,
          maxTokens: params?.maxTokens,
        }),
      );

      const promptTokens = await this.provider.tokenCountForPrompt(prompt);
      yield {
        kind: "done",
        finishReason,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
    } catch (err) {
      throw mapInferenceError(err);
    }
  }

  shutdown(): void {
    this.provider.release();
  }
}

function mapInferenceError(err: unknown): AfmError {
  if (err instanceof z.ZodError) return { kind: "decodingFailure", message: err.message };
  const mapped = SdkErrorMapper.fromError(err);
  if (mapped) return mapped;
  return AfmError.classify(err);
}
