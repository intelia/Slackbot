"use strict";

// Shared structured-output wrapper over the configured AI provider.
// Set AI_PROVIDER=claude (or anthropic) in env to use Claude instead of OpenAI.

const PROVIDER = (process.env.AI_PROVIDER || "openai").toLowerCase();

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

let _openaiClient = null;
let _anthropicClient = null;

function getOpenAIClient() {
  if (!_openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    const { OpenAI } = require("openai");
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiClient;
}

function getAnthropicClient() {
  if (!_anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY)
      throw new Error("ANTHROPIC_API_KEY not set");
    const Anthropic = require("@anthropic-ai/sdk");
    // Identity-linked Console API keys (as opposed to workspace-scoped keys)
    // require the target workspace id on every request.
    const defaultHeaders = process.env.ANTHROPIC_WORKSPACE_ID
      ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
      : undefined;
    _anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultHeaders,
    });
  }
  return _anthropicClient;
}

async function openaiStructuredCompletion({
  schemaName,
  schema,
  systemPrompt,
  userMessage,
}) {
  const client = getOpenAIClient();
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  return JSON.parse(completion.choices[0].message.content);
}

async function claudeStructuredCompletion({
  schemaName,
  schema,
  systemPrompt,
  userMessage,
}) {
  const client = getAnthropicClient();
  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: [
      {
        name: schemaName,
        description: `Extract structured data matching the ${schemaName} schema.`,
        input_schema: schema,
      },
    ],
    tool_choice: { type: "tool", name: schemaName },
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse) throw new Error("Claude response did not include a tool_use block");
  return toolUse.input;
}

// schema must be a plain JSON schema object (no outer response_format/json_schema wrapper).
async function createStructuredCompletion({
  schemaName,
  schema,
  systemPrompt,
  userMessage,
}) {
  if (PROVIDER === "claude" || PROVIDER === "anthropic") {
    return claudeStructuredCompletion({ schemaName, schema, systemPrompt, userMessage });
  }
  return openaiStructuredCompletion({ schemaName, schema, systemPrompt, userMessage });
}

module.exports = { createStructuredCompletion, PROVIDER };
