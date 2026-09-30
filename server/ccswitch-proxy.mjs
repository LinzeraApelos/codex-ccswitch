import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";

// Load local credentials once at startup without overwriting variables that
// were already supplied by the parent process. The file is intentionally
// project-local and should remain untracked.
function loadDotEnv(filePath) {
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (["OPENROUTER_API_KEY", "CHEAPER_INFERENCE_API_KEY"].includes(name) && !process.env[name]) {
      process.env[name] = value;
    }
  }
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDotEnvPath = path.join(projectRoot, ".env");
const userDotEnvPath = path.join(
  process.env.USERPROFILE || process.env.HOME || projectRoot,
  ".codex",
  "ccswitch-keys.env",
);
loadDotEnv(userDotEnvPath);
loadDotEnv(projectDotEnvPath);

// Deliberately never bind the credential-bearing proxy to a network interface.
const host = "127.0.0.1";
const port = Number.parseInt(process.env.CCSWITCH_PORT || "8787", 10);
const catalogPath =
  process.env.CCSWITCH_MODEL_CATALOG ||
  path.join(process.env.USERPROFILE || homedir(), ".codex", "ccswitch-combined-model-catalog.json");

const routes = {
  cheaper: {
    name: "Cheaper Inference",
    apiKeyEnv: "CHEAPER_INFERENCE_API_KEY",
    baseUrl: "https://api.cheaperinference.com/v1",
    external: true,
  },
  openrouter: {
    name: "OpenRouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    external: true,
  },
};

// Bare native slugs continue through the authenticated Codex backend. The
// namespaced slugs below are routed to the external providers.
const nativeRoute = {
  name: "Codex native",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  useIncomingAuth: true,
  external: false,
};

const COMPACT_PROMPT = `You are performing a context checkpoint compaction. Create a concise handoff summary for another model that will resume the task.

Include current progress, decisions, constraints, user preferences, remaining steps, and critical references.`;
const SUMMARY_PREFIX =
  "Another model started this task and produced a continuation summary. Continue from it without repeating completed work:";
const COMPACTION_PREFIX = "ccswitch1:";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function parseModel(model) {
  if (typeof model !== "string") {
    return { error: "The request must include a model string." };
  }

  const separator = model.indexOf("/");
  if (separator < 0 && model.length > 0) {
    return {
      routeId: "native",
      route: nativeRoute,
      upstreamModel: model,
    };
  }

  if (separator <= 0 || separator === model.length - 1) {
    return {
      error:
        "Model IDs must be namespaced as cheaper/<model-id> or openrouter/<provider>/<model-id>.",
    };
  }

  const routeId = model.slice(0, separator);
  const upstreamModel = model.slice(separator + 1);
  const route = routes[routeId];
  if (!route) {
    return {
      error: `Unknown route '${routeId}'. Available routes: ${Object.keys(routes).join(", ")}.`,
    };
  }

  return { routeId, route, upstreamModel };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  let body = Buffer.concat(chunks);
  const encodings = String(req.headers["content-encoding"] || "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== "identity")
    .reverse();

  for (const encoding of encodings) {
    if (encoding === "gzip" || encoding === "x-gzip") body = gunzipSync(body);
    else if (encoding === "deflate") body = inflateSync(body);
    else if (encoding === "br") body = brotliDecompressSync(body);
    else if (encoding === "zstd") body = zstdDecompressSync(body);
    else throw new Error(`Unsupported content encoding: ${encoding}`);
  }

  return body.toString("utf8");
}

function forwardedHeaders(req, apiKey) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": req.headers["content-type"] || "application/json",
  };

  for (const name of ["accept", "openai-beta", "x-client-request-id", "x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version", "x-stainless-retry-count", "x-stainless-runtime", "x-stainless-runtime-version"]) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }

  return headers;
}

function nativeHeaders(req) {
  const headers = {
    "content-type": req.headers["content-type"] || "application/json",
    "accept-encoding": "identity",
  };

  for (const name of [
    "authorization",
    "accept",
    "chatgpt-account-id",
    "openai-beta",
    "originator",
    "session_id",
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-beta-features",
    "x-codex-installation-id",
    "x-codex-parent-thread-id",
    "x-codex-turn-metadata",
    "x-codex-turn-state",
    "x-codex-window-id",
    "x-oai-attestation",
    "x-openai-subagent",
    "x-responsesapi-include-timing-metrics",
  ]) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }

  return headers;
}

function messageItem(text) {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function encodeSummary(summary) {
  return COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

function decodeSummary(value) {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) {
    return undefined;
  }
  try {
    return Buffer.from(value.slice(COMPACTION_PREFIX.length), "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

// Some OpenAI-compatible providers emit reasoning text in a non-standard
// `content` field. Codex can display it, but the native backend rejects that
// field when the same conversation is later continued with an OpenAI model.
function normalizeReasoningItem(item) {
  if (item?.type !== "reasoning" || !Array.isArray(item.content)) return item;

  const { content, ...rest } = item;
  if (!Array.isArray(rest.summary) || rest.summary.length === 0) {
    const summary = content
      .filter((part) =>
        ["reasoning_text", "summary_text", "text", "output_text"].includes(part?.type) &&
        typeof part.text === "string",
      )
      .map((part) => ({ type: "summary_text", text: part.text }));
    if (summary.length > 0) rest.summary = summary;
  }
  return rest;
}

function normalizeInputItems(input, { dropCompactionTrigger = false } = {}) {
  if (!Array.isArray(input)) return input;
  return input
    .filter((item) => !dropCompactionTrigger || item?.type !== "compaction_trigger")
    .map((item) => {
      if (item?.type === "reasoning") {
        const normalized = normalizeReasoningItem(item);
        // Reasoning produced by third-party gateways is neither encrypted nor
        // persisted by the native Codex backend. Replaying its temporary ID
        // makes model switching fail with "item not found", so omit it from
        // subsequent requests. The visible assistant answer remains intact.
        if (
          typeof normalized.encrypted_content !== "string" ||
          normalized.encrypted_content.length === 0
        ) {
          return null;
        }
        return normalized;
      }
      if (item?.type !== "compaction") return item;
      const summary = decodeSummary(item.encrypted_content);
      return summary
        ? messageItem(`${SUMMARY_PREFIX}\n\n${summary}`)
        : messageItem("[Earlier conversation history was compacted.]");
    })
    .filter(Boolean);
}

function flattenOpenRouterTools(tools) {
  if (!Array.isArray(tools)) return [];

  return tools.flatMap((tool) => {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      return flattenOpenRouterTools(tool.tools);
    }

    if (tool?.type === "function" && tool.function && !tool.name) {
      return [{
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
      }];
    }

    // OpenRouter currently rejects the Responses API's free-form `custom`
    // tools. Represent them as a normal function with one string argument so
    // function-only providers can still advertise Codex's local tools.
    if (tool?.type === "custom" && tool.name) {
      return [{
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "The free-form input for this tool.",
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
        strict: false,
      }];
    }

    return [tool];
  });
}

function collectCustomToolNames(tools, names = new Set()) {
  if (!Array.isArray(tools)) return names;

  for (const tool of tools) {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      collectCustomToolNames(tool.tools, names);
    } else if (tool?.type === "custom" && tool.name) {
      names.add(tool.name);
    }
  }

  return names;
}

function encodeCustomToolInput(input) {
  const value = typeof input === "string" ? input : JSON.stringify(input ?? "");
  return JSON.stringify({ input: value });
}

function decodeCustomToolInput(argumentsText) {
  if (typeof argumentsText !== "string") {
    return JSON.stringify(argumentsText ?? "");
  }

  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed.input === "string") return parsed.input;
  } catch {
    // Keep malformed or partial provider output as free-form input.
  }

  return argumentsText;
}

function normalizeOpenRouterInputItem(item, customToolNames) {
  if (item?.type === "custom_tool_call" && customToolNames.has(item.name)) {
    const { input, ...rest } = item;
    return {
      ...rest,
      type: "function_call",
      arguments: encodeCustomToolInput(input),
    };
  }

  if (item?.type === "custom_tool_call_output") {
    return { ...item, type: "function_call_output" };
  }

  return item;
}

function transformOpenRouterOutputItem(item, customToolNames, state) {
  if (item?.type === "reasoning") {
    return normalizeReasoningItem(item);
  }

  if (item?.type !== "function_call" || !customToolNames.has(item.name)) {
    return item;
  }

  if (item.id) state.itemIds.add(item.id);
  if (item.call_id) state.callIds.add(item.call_id);

  const { arguments: argumentsText, ...rest } = item;
  return {
    ...rest,
    type: "custom_tool_call",
    input: decodeCustomToolInput(argumentsText),
  };
}

function transformOpenRouterEvent(event, customToolNames, state) {
  if (!event || typeof event !== "object") return event;

  if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
    return {
      ...event,
      item: transformOpenRouterOutputItem(event.item, customToolNames, state),
    };
  }

  const itemId = event.item_id;
  const callId = event.call_id;
  const isCustomCall =
    (itemId && state.itemIds.has(itemId)) ||
    (callId && state.callIds.has(callId));

  if (isCustomCall && event.type === "response.function_call_arguments.delta") {
    return { ...event, type: "response.custom_tool_call_input.delta" };
  }

  if (isCustomCall && event.type === "response.function_call_arguments.done") {
    const { arguments: argumentsText, ...rest } = event;
    return {
      ...rest,
      type: "response.custom_tool_call_input.done",
      input: decodeCustomToolInput(argumentsText),
    };
  }

  if (event.type === "response.completed" && event.response?.output) {
    return {
      ...event,
      response: {
        ...event.response,
        output: event.response.output.map((item) =>
          transformOpenRouterOutputItem(item, customToolNames, state),
        ),
      },
    };
  }

  return event;
}

function transformExternalResponse(payload, customToolNames) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.output)) {
    return payload;
  }
  const state = { itemIds: new Set(), callIds: new Set() };
  return {
    ...payload,
    output: payload.output.map((item) =>
      transformOpenRouterOutputItem(item, customToolNames, state),
    ),
  };
}

function transformExternalStream(body, customToolNames) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = { itemIds: new Set(), callIds: new Set() };

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      let buffer = "";

      const emitFrame = (frame) => {
        const lines = frame.split(/\r?\n/);
        const dataIndex = lines.findIndex((line) => line.startsWith("data:"));
        if (dataIndex < 0) {
          controller.enqueue(encoder.encode(frame));
          return;
        }

        const data = lines[dataIndex].slice(5).trimStart();
        if (data === "[DONE]") {
          controller.enqueue(encoder.encode(frame));
          return;
        }

        try {
          const event = JSON.parse(data);
          const transformed = transformOpenRouterEvent(event, customToolNames, state);
          lines[dataIndex] = `data: ${JSON.stringify(transformed)}`;
          controller.enqueue(encoder.encode(lines.join("\n")));
        } catch {
          controller.enqueue(encoder.encode(frame));
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const lfBoundary = buffer.indexOf("\n\n");
            const crlfBoundary = buffer.indexOf("\r\n\r\n");
            let boundary = lfBoundary;
            let separatorLength = 2;
            if (crlfBoundary >= 0 && (lfBoundary < 0 || crlfBoundary < lfBoundary)) {
              boundary = crlfBoundary;
              separatorLength = 4;
            }
            if (boundary < 0) break;

            emitFrame(buffer.slice(0, boundary + separatorLength));
            buffer = buffer.slice(boundary + separatorLength);
          }
        }

        buffer += decoder.decode();
        if (buffer) emitFrame(buffer);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const text = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (["output_text", "text"].includes(part?.type) && typeof part.text === "string") {
        text.push(part.text);
      }
    }
  }
  const chatText = payload?.choices?.[0]?.message?.content;
  if (typeof chatText === "string") text.push(chatText);
  return text.join("\n");
}

function extractUserMessages(input) {
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type !== undefined && item.type !== "message") continue;
    if (item.role !== "user") continue;
    const text = Array.isArray(item.content)
      ? item.content
          .filter((part) =>
            ["input_text", "text"].includes(part?.type) && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("")
      : typeof item.content === "string"
        ? item.content
        : "";
    if (text.trim()) messages.push(text);
  }
  return messages;
}

function compactOutput(input, summary) {
  const budget = 80_000;
  const selected = [];
  let remaining = budget;
  const messages = extractUserMessages(input);
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const value = messages[index];
    if (value.length <= remaining) {
      selected.push(value);
      remaining -= value.length;
    } else {
      selected.push(value.slice(value.length - remaining));
      break;
    }
  }
  selected.reverse();
  return [
    ...selected.map(messageItem),
    messageItem(summary.trim() ? `${SUMMARY_PREFIX}\n\n${summary}` : "(no summary available)"),
  ];
}

function compactionSnapshot(model, item, status = "completed") {
  return {
    id: `resp_${randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status,
    model,
    output: item ? [item] : [],
    usage: null,
  };
}

function writeCompactionSse(res, model, summary) {
  const item = {
    type: "compaction",
    id: `cmp_${randomUUID().replaceAll("-", "")}`,
    encrypted_content: encodeSummary(summary),
  };
  const created = compactionSnapshot(model, undefined, "in_progress");
  const completed = { ...created, status: "completed", output: [item] };
  const events = [
    ["response.created", { response: created }],
    ["response.output_item.done", { output_index: 0, item }],
    ["response.completed", { response: completed }],
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  events.forEach(([type, data], sequence) => {
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...data })}\n\n`,
    );
  });
  res.end("data: [DONE]\n\n");
}

async function handleExternalCompaction(req, res, request, parsed, v2) {
  const apiKey = process.env[parsed.route.apiKeyEnv];
  if (!apiKey) {
    json(res, 503, {
      error: {
        message: `${parsed.route.name} is selected, but ${parsed.route.apiKeyEnv} is not set in the environment.`,
        type: "configuration_error",
      },
    });
    return;
  }

  const originalInput = Array.isArray(request.input) ? request.input : [];
  const normalizedInput = normalizeInputItems(originalInput, {
    dropCompactionTrigger: true,
  }).filter((item) => item?.type !== "additional_tools");
  const body = {
    ...request,
    model: parsed.upstreamModel,
    stream: false,
    tools: [],
    tool_choice: "none",
    input: [...normalizedInput, messageItem(COMPACT_PROMPT)],
  };
  delete body.client_metadata;
  delete body.previous_response_id;
  delete body.include;

  let upstream;
  try {
    upstream = await fetch(`${parsed.route.baseUrl}/responses`, {
      method: "POST",
      headers: forwardedHeaders(req, apiKey),
      body: JSON.stringify(body),
    });
  } catch (error) {
    json(res, 502, {
      error: {
        message: `Could not reach ${parsed.route.name} for conversation compaction.`,
        type: "upstream_connection_error",
        detail: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  const text = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: { message: text || "Invalid compaction response." } };
  }
  if (!upstream.ok) {
    json(res, upstream.status, payload);
    return;
  }

  const summary = extractResponseText(payload);
  if (v2) {
    const item = {
      type: "compaction",
      id: `cmp_${randomUUID().replaceAll("-", "")}`,
      encrypted_content: encodeSummary(summary),
    };
    if (request.stream === false) {
      json(res, 200, compactionSnapshot(request.model, item));
    } else {
      writeCompactionSse(res, request.model, summary);
    }
    return;
  }
  json(res, 200, { output: compactOutput(originalInput, summary) });
}

async function handleResponses(req, res, url) {
  let request;
  try {
    request = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: { message: "Request body must be valid JSON." } });
    return;
  }

  const parsed = parseModel(request.model);
  if (parsed.error) {
    json(res, 400, { error: { message: parsed.error } });
    return;
  }

  const compactV1 = /\/responses\/compact$/.test(url.pathname);
  const compactV2 =
    parsed.route.external &&
    Array.isArray(request.input) &&
    request.input.at(-1)?.type === "compaction_trigger";
  if (parsed.route.external && (compactV1 || compactV2)) {
    await handleExternalCompaction(req, res, request, parsed, compactV2);
    return;
  }

  const apiKey = parsed.route.apiKeyEnv
    ? process.env[parsed.route.apiKeyEnv]
    : null;
  if (!apiKey && !parsed.route.useIncomingAuth) {
    json(res, 503, {
      error: {
        message: `${parsed.route.name} is selected, but ${parsed.route.apiKeyEnv} is not set in the environment.`,
        type: "configuration_error",
      },
    });
    return;
  }
  if (parsed.route.useIncomingAuth && !req.headers.authorization) {
    json(res, 401, {
      error: {
        message: "The native route requires Codex authentication.",
        type: "authentication_error",
      },
    });
    return;
  }

  const upstreamBody = { ...request, model: parsed.upstreamModel };
  if (Array.isArray(upstreamBody.input)) {
    upstreamBody.input = normalizeInputItems(upstreamBody.input, {
      dropCompactionTrigger: parsed.route.external,
    });
  }

  if (parsed.route.external) {
    // Codex uses client metadata for its own runtime. It is not part of the
    // public provider request and some gateways reject unknown top-level fields.
    delete upstreamBody.client_metadata;

    // External stateless Responses gateways cannot replay encrypted native
    // reasoning. Codex can continue from the visible input/tool items, so keep
    // the requested effort but remove native-only replay metadata.
    if (Array.isArray(upstreamBody.include)) {
      const compatibleIncludes = upstreamBody.include.filter(
        (item) => item !== "reasoning.encrypted_content",
      );
      if (compatibleIncludes.length > 0) {
        upstreamBody.include = compatibleIncludes;
      } else {
        delete upstreamBody.include;
      }
    }

    if (upstreamBody.reasoning && typeof upstreamBody.reasoning === "object") {
      const compatibleReasoning = {};
      if (upstreamBody.reasoning.effort) {
        compatibleReasoning.effort = upstreamBody.reasoning.effort;
      }
      if (upstreamBody.reasoning.mode && upstreamBody.reasoning.mode !== "pro") {
        compatibleReasoning.mode = upstreamBody.reasoning.mode;
      }
      if (Object.keys(compatibleReasoning).length > 0) {
        upstreamBody.reasoning = compatibleReasoning;
      } else {
        delete upstreamBody.reasoning;
      }
    }

    // Codex uses this internal marker to request context compaction. It is
    // meaningful to the native Codex backend, but it is not a valid public
    // Responses input item for Cheaper Inference or OpenRouter.
    // Compaction triggers are handled before normal provider requests.
  }

  const customToolNames = new Set();
  if (parsed.routeId === "openrouter" && Array.isArray(upstreamBody.input)) {
    const additionalToolItems = upstreamBody.input.filter(
      (item) => item?.type === "additional_tools",
    );
    for (const item of additionalToolItems) {
      collectCustomToolNames(item.tools, customToolNames);
    }
    const additionalTools = additionalToolItems.flatMap((item) =>
      flattenOpenRouterTools(item.tools),
    );

    upstreamBody.input = upstreamBody.input.filter(
      (item) => item?.type !== "additional_tools",
    ).map((item) => normalizeOpenRouterInputItem(item, customToolNames));

    if (additionalTools.length > 0) {
      upstreamBody.tools = [
        ...(Array.isArray(upstreamBody.tools) ? upstreamBody.tools : []),
        ...additionalTools,
      ];
    }
  }
  const upstreamUrl = `${parsed.route.baseUrl}${compactV1 ? "/responses/compact" : "/responses"}`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: parsed.route.useIncomingAuth
        ? nativeHeaders(req)
        : forwardedHeaders(req, apiKey),
      body: JSON.stringify(upstreamBody),
    });
  } catch (error) {
    json(res, 502, {
      error: {
        message: `Could not reach ${parsed.route.name}.`,
        type: "upstream_connection_error",
        detail: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  if (!upstream.ok) {
    const errorBody = await upstream.text();
    res.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);
    res.end(errorBody);
    return;
  }

  res.statusCode = upstream.status;
  for (const name of ["content-type", "cache-control", "x-request-id", "openai-processing-ms"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  const upstreamContentType = upstream.headers.get("content-type") || "";
  if (parsed.route.external && upstreamContentType.includes("application/json")) {
    const text = await upstream.text();
    try {
      res.end(JSON.stringify(transformExternalResponse(JSON.parse(text), customToolNames)));
    } catch {
      res.end(text);
    }
    return;
  }

  const responseBody = parsed.route.external
    ? transformExternalStream(upstream.body, customToolNames)
    : upstream.body;

  Readable.fromWeb(responseBody).pipe(res);
}

async function handleNativePassthrough(req, res, url) {
  if (!req.headers.authorization) {
    json(res, 401, {
      error: {
        message: "This Codex route requires native authentication.",
        type: "authentication_error",
      },
    });
    return;
  }

  const nativePath = url.pathname.startsWith("/v1/")
    ? url.pathname.slice(3)
    : url.pathname;
  const target = `${nativeRoute.baseUrl}${nativePath}${url.search}`;
  const method = req.method || "GET";
  let body;
  if (method !== "GET" && method !== "HEAD") {
    const decoded = await readBody(req);
    if (decoded.length > 0) body = decoded;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers: nativeHeaders(req),
      body,
    });
  } catch (error) {
    json(res, 502, {
      error: {
        message: "Could not reach the native Codex service.",
        type: "upstream_connection_error",
        detail: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  res.statusCode = upstream.status;
  for (const name of [
    "content-type",
    "cache-control",
    "x-request-id",
    "openai-processing-ms",
  ]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

function listModels() {
  return catalogModels().map(({ slug: id }) => ({
    id,
    object: "model",
    owned_by: id.split("/")[0],
  }));
}

function catalogModels() {
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, "utf8"));
    if (Array.isArray(parsed.models)) return parsed.models;
  } catch {
    // An absent catalog is a setup error; never advertise invented models.
  }
  return [];
}

const server = http.createServer(async (req, res) => {
  // Block browser cross-origin requests and DNS rebinding to this local proxy.
  const authority = String(req.headers.host || "");
  if (!new RegExp(`^127\\.0\\.0\\.1:${port}$`).test(authority) ||
      (req.headers.origin && !new RegExp(`^http://127\\.0\\.0\\.1:${port}$`).test(req.headers.origin))) {
    json(res, 403, { error: { message: "Local requests only." } });
    return;
  }
  if (req.method === "POST" && !String(req.headers["content-type"] || "").startsWith("application/json")) {
    json(res, 415, { error: { message: "application/json required." } });
    return;
  }
  // This also picks up a newly-created .env without requiring another proxy
  // restart. Existing process environment variables remain authoritative.
  loadDotEnv(userDotEnvPath);
  loadDotEnv(projectDotEnvPath);
  const url = new URL(req.url || "/", `http://${host}:${port}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    json(res, 200, {
      ok: true,
      service: "ccswitch-proxy",
      routes: Object.keys(routes),
      configured: Object.fromEntries(
        Object.entries(routes).map(([id, route]) => [id, Boolean(process.env[route.apiKeyEnv])]),
      ),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const data = listModels();
    json(res, 200, {
      object: "list",
      data,
      // Codex Desktop's built-in model manager expects this catalog-shaped
      // field, while OpenAI-compatible clients expect `data`.
      models: catalogModels(),
    });
    return;
  }

  if (
    req.method === "POST" &&
    ["/v1/responses", "/v1/responses/compact"].includes(url.pathname)
  ) {
    await handleResponses(req, res, url);
    return;
  }

  await handleNativePassthrough(req, res, url);
});

// The built-in Codex provider tries a WebSocket first. This proxy supports
// Responses over HTTP/SSE; 426 tells Codex to fall back immediately instead
// of exhausting its WebSocket reconnect budget on every new session.
server.on("upgrade", (_req, socket) => {
  socket.end(
    "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
});

server.listen(port, host, () => {
  console.log(`CCswitch proxy listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
