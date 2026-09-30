import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("loopback health, catalog and missing-key handling", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ccswitch-test-"));
  const catalog = path.join(directory, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ models: [
    { slug: "native-example", display_name: "Native" },
    { slug: "openrouter/example/test", display_name: "Test" },
  ] }));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, ["server/ccswitch-proxy.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      USERPROFILE: directory,
      HOME: directory,
      CCSWITCH_PORT: String(port),
      CCSWITCH_MODEL_CATALOG: catalog,
      OPENROUTER_API_KEY: "",
      CHEAPER_INFERENCE_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Proxy exited: ${code}`)));
      child.stdout.once("data", resolve);
      setTimeout(() => reject(new Error("Proxy did not start")), 5000).unref();
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.configured.openrouter, false);
    const listing = await (await fetch(`${base}/v1/models`)).json();
    assert.deepEqual(listing.data.map((model) => model.id), ["native-example", "openrouter/example/test"]);
    const foreignOrigin = await fetch(`${base}/v1/models`, { headers: { origin: "https://example.org" } });
    assert.equal(foreignOrigin.status, 403);
    const request = { method: "POST", headers: { "content-type": "application/json" } };
    const missingKey = await fetch(`${base}/v1/responses`, {
      ...request, body: JSON.stringify({ model: "openrouter/example/test", input: [] }),
    });
    assert.equal(missingKey.status, 503);
    const nativeAuth = await fetch(`${base}/v1/responses`, {
      ...request, body: JSON.stringify({ model: "native-example", input: [] }),
    });
    assert.equal(nativeAuth.status, 401);
  } finally {
    child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});
