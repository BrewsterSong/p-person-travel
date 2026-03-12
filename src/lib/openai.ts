import OpenAI from "openai";

const apiKey = process.env.SILICONFLOW_API_KEY;

if (!apiKey) {
  console.warn("SILICONFLOW_API_KEY is not set");
}

export const openai = new OpenAI({
  apiKey: apiKey || "",
  baseURL: "https://api.siliconflow.cn/v1",
});

// Default model as per PRD
export const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V2-Chat";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(messages: ChatMessage[], model: string = DEFAULT_MODEL) {
  const response = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.7,
  });

  return response.choices[0]?.message?.content || "";
}
