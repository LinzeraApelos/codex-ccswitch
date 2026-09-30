# CCswitch for Codex

Show native Codex models and selected external models in one desktop model picker. A loopback-only Responses proxy routes `openrouter/<model-id>` to OpenRouter, `cheaper/<model-id>` to Cheaper Inference, and unprefixed model IDs to the native Codex service. This is an independent community project, not an OpenAI feature or a universal one-click installer.

**Important trade-off:** with `ccswitch` as the global provider, **native models also depend on the local proxy**. If it stops, restore your original configuration or restart the proxy. Test an isolated CLI profile before switching the desktop app. Review third-party code before running it, and never paste an API key into a chat or repository.

Prefer Portuguese? Read the [Portuguese guide](docs/pt-BR/README.md). The main documentation, source comments, examples, and default prompt are in English.

## Four-line setup prompt

Open [PROMPT.md](PROMPT.md), replace the model IDs, and paste it into Codex. The agent should back up your settings, request credentials through a local no-echo input, test a real tool-using turn, and explain rollback. An [older English prompt link](PROMPT.en.md) remains available.

## Manual setup (Node.js 22+, Codex CLI/Desktop)

1. Back up `~/.codex/config.toml`. Confirm your installed Codex version supports custom providers and `model_catalog_json`.
2. Clone this repository. Copy `models.example.json` to `models.json` (Git ignores it). Replace the examples with exact provider model IDs and their actual context limits. Prefix OpenRouter IDs with `openrouter/` and Cheaper Inference IDs with `cheaper/`. Example IDs and limits may become outdated. A picker entry does **not** prove tool calls, images, compaction, or streaming work with that model.
3. Put `OPENROUTER_API_KEY=...` and/or `CHEAPER_INFERENCE_API_KEY=...` in `~/.codex/ccswitch-keys.env`, outside this repository. Restrict file access to your user. The proxy also accepts environment variables or a Git-ignored `.env` in the project directory. Do not commit, screenshot, or send a key in chat.
4. Open Codex once to populate its native model cache. Run `npm run catalog` from this directory. It writes `~/.codex/ccswitch-combined-model-catalog.json` using the local native cache and your `models.json`. Restart Codex after catalog changes.
5. Run `npm run proxy`. Check `http://127.0.0.1:8787/healthz` for `ok: true` and the appropriate `configured` flag. The proxy binds specifically to the reserved **loopback** address `127.0.0.1`; this is not a public or personal IP. Test a small external request, a request involving a tool, and a native request. A successful health check or visible picker entry alone is insufficient.
6. For an isolated CLI test, keep your global provider unchanged. Create `~/.codex/ccswitch.config.toml` with top-level keys (replace the absolute catalog path and model ID):

```toml
model_provider = "ccswitch"
model = "openrouter/z-ai/glm-5.3-flash"
model_catalog_json = "/ABSOLUTE/PATH/TO/.codex/ccswitch-combined-model-catalog.json"

[model_providers.ccswitch]
name = "CCswitch local"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
```

Run `codex --profile ccswitch`. In current Codex versions, profiles are separate `<name>.config.toml` files under `CODEX_HOME`, **not** `[profiles.<name>]` tables in the main config. See the [official profile documentation](https://developers.openai.com/codex/config-advanced).

7. Only after the profile works, decide whether to enable the combined desktop picker. Back up the main `config.toml` again, place `model_provider = "ccswitch"` and `model_catalog_json = "/ABSOLUTE/PATH/TO/.codex/ccswitch-combined-model-catalog.json"` **before any TOML table**, and add the `[model_providers.ccswitch]` table from the profile without duplicating an existing table. Preserve your native default model and all unrelated settings. Restart the app and validate both native and external routes. Arrange user-level startup for the proxy only after testing restart and rollback; this repository does not install a background service.

## Rollback

Restore your original `config.toml` and restart Codex. Stop the proxy and remove any startup task you created. This does not delete conversations or cancel external-provider credits.

## Security and compatibility

- Read [SECURITY.md](SECURITY.md) before enabling the proxy globally.
- There are **no personal server addresses, SSH details, API keys, or private file paths** in this repository. The only numeric IP literal is `127.0.0.1`, the reserved local loopback address required to prevent network exposure. Do not rebind the proxy to a public interface or forward its port.
- External keys are loaded locally and sent only to their configured provider. Native Codex authentication is forwarded only to the native Codex endpoint. The proxy does not log request bodies or keys. Nonetheless, another process running as your user can potentially access a local service; inspect the code and protect your machine.
- The bridge adapts some Responses tool/event types for external gateways. Model support varies; some models reject fields or fail tool calls and compaction. External usage is billed by the external provider, separately from any Codex subscription.
- Desktop picker behavior can change across Codex releases. Verify the catalog and provider behavior on your version before relying on it.

Official OpenAI documentation: [custom model providers and profiles](https://developers.openai.com/codex/config-advanced), [configuration reference](https://developers.openai.com/codex/config-reference).
