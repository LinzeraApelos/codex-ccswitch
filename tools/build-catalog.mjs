import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const cachePath = path.join(codexHome, "models_cache.json");
const definitionsPath = path.join(process.cwd(), "models.json");
const fallbackPath = path.join(process.cwd(), "models.example.json");
const outputPath = path.join(codexHome, "ccswitch-combined-model-catalog.json");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const native = readJson(cachePath).models;
if (!Array.isArray(native) || native.length === 0) {
  throw new Error(`No native Codex models in ${cachePath}; open Codex once first.`);
}
let definitions;
try {
  definitions = readJson(definitionsPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  definitions = readJson(fallbackPath);
}
if (!Array.isArray(definitions)) throw new Error("models.json must be an array.");

const nativeSlugs = new Set(native.map((model) => model.slug));
const seen = new Set(nativeSlugs);
const external = definitions.map((entry) => {
  if (!entry || typeof entry.slug !== "string" ||
      !/^(openrouter|cheaper)\/[a-zA-Z0-9._/-]+$/.test(entry.slug) ||
      entry.slug.includes("..") || seen.has(entry.slug)) {
    throw new Error(`Invalid or duplicate model slug: ${entry?.slug}`);
  }
  if (typeof entry.display_name !== "string" || !entry.display_name.trim()) {
    throw new Error(`Missing display_name for ${entry.slug}`);
  }
  if (!Number.isInteger(entry.context_window) || entry.context_window < 1024) {
    throw new Error(`Set the provider's actual context_window for ${entry.slug}`);
  }
  seen.add(entry.slug);
  const model = structuredClone(native[0]);
  Object.assign(model, {
    slug: entry.slug,
    display_name: entry.display_name,
    description: `${entry.display_name} through a local CCswitch router.`,
    default_reasoning_level: "medium",
    supported_reasoning_levels: ["low", "medium", "high"].map((effort) => ({
      effort, description: `${effort} reasoning (provider support varies)`,
    })),
    visibility: "list",
    supported_in_api: true,
    priority: 100,
    context_window: entry.context_window,
    max_context_window: entry.context_window,
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    use_responses_lite: true,
    tool_mode: "code_mode_only",
    experimental_supported_tools: [],
    default_reasoning_summary: "none",
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
  });
  for (const key of ["additional_speed_tiers", "service_tiers", "available_access_programs", "upgrade"]) {
    delete model[key];
  }
  return model;
});

writeFileSync(outputPath, JSON.stringify({ models: [...native, ...external] }, null, 2) + "\n", { flag: "w", mode: 0o600 });
console.log(`Catalog: ${native.length} native + ${external.length} external models at ${outputPath}`);
