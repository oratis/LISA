import { test, describe } from "node:test";
import assert from "node:assert/strict";

// localEndpoint("ollama") consults OLLAMA_HOST; clear it so the default is
// deterministic regardless of the runner's environment.
delete process.env.OLLAMA_HOST;

import {
  parseLocalRef,
  parseOllamaTags,
  localEndpoint,
  OllamaBackend,
  type LocalRuntime,
} from "./local.js";

describe("parseLocalRef", () => {
  test("local://model → ollama + model", () => {
    assert.deepEqual(parseLocalRef("local://qwen2.5-coder:32b"), {
      backend: "ollama",
      model: "qwen2.5-coder:32b",
    });
  });
  test("local://backend/model → that backend", () => {
    assert.deepEqual(parseLocalRef("local://lmstudio/qwen"), {
      backend: "lmstudio",
      model: "qwen",
    });
  });
  test("unknown prefix stays part of the model name", () => {
    assert.deepEqual(parseLocalRef("local://hf.co/user/model"), {
      backend: "ollama",
      model: "hf.co/user/model",
    });
  });
  test("non-local refs and empty → null", () => {
    assert.equal(parseLocalRef("gpt-4o"), null);
    assert.equal(parseLocalRef("local://"), null);
  });
});

describe("localEndpoint", () => {
  test("ollama → :11434/v1, apiKey is the backend name", () => {
    const ep = localEndpoint("ollama");
    assert.equal(ep.baseURL, "http://localhost:11434/v1");
    assert.equal(ep.apiKey, "ollama");
  });
  test("lmstudio → :1234", () => {
    assert.match(localEndpoint("lmstudio").baseURL, /:1234\/v1$/);
  });
  test("unknown backend falls back to the ollama host", () => {
    assert.match(localEndpoint("weird").baseURL, /:11434\/v1$/);
  });
  test("OLLAMA_HOST without a scheme still yields a URL, as Ollama reads it", () => {
    const at = (OLLAMA_HOST: string): string => localEndpoint("ollama", { OLLAMA_HOST }).baseURL;
    // The usual server setting; it used to become "0.0.0.0:11434/v1".
    assert.equal(at("0.0.0.0:11434"), "http://0.0.0.0:11434/v1");
    assert.equal(at("gpu-box"), "http://gpu-box:11434/v1");
    assert.equal(at("[::1]:9000"), "http://[::1]:9000/v1");
    assert.equal(at(" http://localhost:11434/ "), "http://localhost:11434/v1");
    assert.equal(at("https://ollama.example.com"), "https://ollama.example.com/v1");
    // Another backend never reads OLLAMA_HOST.
    assert.equal(
      localEndpoint("lmstudio", { OLLAMA_HOST: "0.0.0.0:1" }).baseURL,
      "http://localhost:1234/v1",
    );
  });
});

describe("parseOllamaTags", () => {
  test("extracts name + size, tolerates missing size", () => {
    const out = parseOllamaTags(
      JSON.stringify({
        models: [{ name: "qwen:7b", size: 4_700_000_000 }, { name: "llama3.1:70b" }],
      }),
    );
    assert.equal(out.length, 2);
    assert.equal(out[0]!.name, "qwen:7b");
    assert.equal(out[0]!.sizeBytes, 4_700_000_000);
    assert.equal(out[1]!.sizeBytes, undefined);
  });
  test("malformed / empty JSON → []", () => {
    assert.deepEqual(parseOllamaTags("not json"), []);
    assert.deepEqual(parseOllamaTags("{}"), []);
  });
});

function fakeRuntime(over: Partial<LocalRuntime> = {}): LocalRuntime {
  return {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    httpGet: async () => ({ ok: true, status: 200, body: JSON.stringify({ models: [] }) }),
    ...over,
  };
}

describe("OllamaBackend", () => {
  test("health is up when /api/tags responds ok", async () => {
    assert.equal(await new OllamaBackend(fakeRuntime()).health(), "up");
  });
  test("health is down when the endpoint is unreachable", async () => {
    const b = new OllamaBackend(
      fakeRuntime({ httpGet: async () => ({ ok: false, status: 0, body: "" }) }),
    );
    assert.equal(await b.health(), "down");
  });
  test("listInstalled parses the tags response", async () => {
    const b = new OllamaBackend(
      fakeRuntime({
        httpGet: async () => ({
          ok: true,
          status: 200,
          body: JSON.stringify({ models: [{ name: "qwen:7b", size: 1 }] }),
        }),
      }),
    );
    assert.equal((await b.listInstalled())[0]!.name, "qwen:7b");
  });
  test("install shells out to `ollama pull <model>` and resolves on exit 0", async () => {
    const calls: string[][] = [];
    const b = new OllamaBackend(
      fakeRuntime({
        exec: async (cmd, args) => {
          calls.push([cmd, ...args]);
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    );
    await b.install("qwen:7b");
    assert.deepEqual(calls[0], ["ollama", "pull", "qwen:7b"]);
  });
  test("install gives a friendly error when ollama is missing (exit 127)", async () => {
    const b = new OllamaBackend(
      fakeRuntime({ exec: async () => ({ code: 127, stdout: "", stderr: "" }) }),
    );
    await assert.rejects(b.install("x"), /ollama CLI not found/);
  });
  test("install surfaces the stderr tail on a non-zero exit", async () => {
    const b = new OllamaBackend(
      fakeRuntime({ exec: async () => ({ code: 1, stdout: "", stderr: "manifest not found" }) }),
    );
    await assert.rejects(b.install("x"), /manifest not found/);
  });
});
