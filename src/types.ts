export type RecollectRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "developer";

export interface RecollectTextPart {
  type: "text";
  text: string;
}

export interface RecollectFilePart {
  type: "file";
  filename?: string;
  mediaType?: string;
  data?: unknown;
}

export interface RecollectToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

export interface RecollectToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output?: unknown;
  result?: unknown;
}

export interface RecollectReasoningPart {
  type: "reasoning";
  text?: string;
}

export interface RecollectUnknownPart {
  type: string;
  [key: string]: unknown;
}

export type RecollectContentPart =
  | RecollectTextPart
  | RecollectFilePart
  | RecollectToolCallPart
  | RecollectToolResultPart
  | RecollectReasoningPart
  | RecollectUnknownPart;

export interface RecollectMessage {
  role: RecollectRole;
  content: string | RecollectContentPart[];
}
