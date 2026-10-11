export type Role = "customer" | "agent";

/** "customer" is the AI actor, "agent" is the learner (also the candidate in interviews). */
export interface Message {
  role: Role;
  text: string;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
