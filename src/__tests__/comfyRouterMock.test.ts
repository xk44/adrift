/**
 * Router end to end against two loopback mock ComfyUIs
 * (scripts/mock-comfy/server.mjs; fake runs, no GPU) plus a dead port and a
 * stub that refuses uploads: failover only past machines that never got the
 * job, inputs staged onto the machine that ran it, outputs tagged with its
 * marker and its prompt id remembered for history/progress.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  env: { COMFY_HTTP_URL: "http://127.0.0.1:1", COMFY_ROOT: "/nonexistent" },
}));
vi.mock("@/lib/env", () => envMock);

import { queuePromptRouted } from "@/lib/comfy/router";
import {
  _resetBackendStateForTests,
  backendForSubfolder,
  candidateBackendUrls,
} from "@/lib/comfy/backends";
import { writeComfyInstances, writeComfyRouting } from "@/lib/runtimeSettings";
import type { Workflow } from "@/types";

const APP = process.cwd();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface Mock {
  url: string;
  proc: ChildProcess;
  log: string[];
}

async function startMock(): Promise<Mock> {
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [path.join(APP, "scripts/mock-comfy/server.mjs"), "--port", String(port)],
    {
      env: { ...process.env, MOCK_COMFY_LOG: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const log: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("mock-comfy did not start")),
      15_000,
    );
    proc.stdout!.on("data", (b: Buffer) => {
      for (const line of b.toString().split("\n")) {
        if (line.startsWith("[mock-comfy] http://")) {
          clearTimeout(t);
          resolve();
        } else if (line.trim()) log.push(line.trim());
      }
    });
    proc.once("exit", () => reject(new Error("mock-comfy exited")));
  });
  return { url: `http://127.0.0.1:${port}`, proc, log };
}

let A: Mock;
let B: Mock;
let refuser: http.Server;
let refuserUrl = "";
const refuserLog: string[] = [];
let deadUrl = "";
const savedSettings = process.env.ADRIFT_RUNTIME_SETTINGS_FILE;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "COMFY_VIDEO_HTTP_URL",
  "CJ_H3_WARM_URL",
  "COMFY_EXCLUSIVE_BACKENDS",
  "COMFY_BEARER",
];

beforeAll(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  [A, B] = await Promise.all([startMock(), startMock()]);
  refuser = http.createServer((req, res) => {
    refuserLog.push(`${req.method} ${req.url?.split("?")[0]}`);
    req.resume();
    res.writeHead(req.method === "POST" ? 500 : 404, {
      "content-type": "application/json",
    });
    res.end("{}");
  });
  await new Promise<void>((r) => refuser.listen(0, "127.0.0.1", () => r()));
  refuserUrl = `http://127.0.0.1:${(refuser.address() as net.AddressInfo).port}`;
  deadUrl = `http://127.0.0.1:${await freePort()}`;

  envMock.env.COMFY_HTTP_URL = A.url;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-router-mock-"));
  process.env.ADRIFT_RUNTIME_SETTINGS_FILE = path.join(dir, "settings.json");
  _resetBackendStateForTests();
  writeComfyInstances({
    instances: [
      { id: "b", name: "Box B", httpUrl: B.url, role: "all", enabled: true },
      {
        id: "c",
        name: "Refuser",
        httpUrl: refuserUrl,
        role: "all",
        enabled: true,
      },
      { id: "d", name: "Dead", httpUrl: deadUrl, role: "all", enabled: true },
    ],
  });
  writeComfyRouting({ auto: true, priorities: { d: 10, c: 5, b: 1 } });
}, 30_000);

afterAll(() => {
  A?.proc.kill();
  B?.proc.kill();
  refuser?.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (savedSettings === undefined)
    delete process.env.ADRIFT_RUNTIME_SETTINGS_FILE;
  else process.env.ADRIFT_RUNTIME_SETTINGS_FILE = savedSettings;
});

describe("router against mock ComfyUIs", () => {
  it("fails over past never-sent machines and keeps uploads/outputs on the one that ran it", async () => {
    const sample = fs
      .readdirSync(path.join(APP, "public/tool-previews"))
      .find((f) => f.endsWith(".webp"))!;
    const workflow = {
      "1": { class_type: "LoadImage", inputs: { image: `${sample} [input]` } },
      "2": {
        class_type: "SaveImage",
        inputs: { images: ["1", 0], filename_prefix: "routing_test" },
      },
    } as unknown as Workflow;

    // Health is a 4 s cache in production; pretend every machine looked
    // alive at plan time so the dead one and the refuser are tried first.
    const health = async () => ({
      reachable: true,
      queue: { running: 0, pending: 0 },
      device: null,
      checkedAt: Date.now(),
    });
    const result = await queuePromptRouted(
      workflow,
      "routing-test",
      undefined,
      { action: "vary" },
      {},
      { health, log: () => {} },
    );

    expect(result.backend).toEqual({ id: "b", name: "Box B" });
    expect(result.route).toEqual({
      mode: "auto",
      failedOver: ["Dead", "Refuser"],
    });
    expect(result.warnings?.at(-1)).toMatch(
      /Dead, Refuser offline; ran on Box B/,
    );

    // The refuser only ever saw the (failed) input upload, never a prompt.
    expect(refuserLog.filter((l) => l.startsWith("POST"))).toEqual([
      "POST /upload/image",
    ]);

    // B ran it: staged input, marker-tagged output.
    const q = (await (await fetch(`${B.url}/queue`)).json()) as {
      queue_running: [
        number,
        string,
        Record<string, { inputs: Record<string, unknown> }>,
      ][];
    };
    const run = q.queue_running.find((r) => r[1] === result.prompt_id);
    expect(run).toBeDefined();
    const graph = run![2];
    expect(String(graph["2"].inputs.filename_prefix)).toMatch(
      /^adrift-b\/routing_test/,
    );
    expect(graph["1"].inputs.image).not.toBe(`${sample} [input]`);
    expect(String(graph["1"].inputs.image)).toMatch(/\[input\]$/);
    expect(B.log).toEqual(
      expect.arrayContaining(["POST /upload/image", "POST /prompt"]),
    );
    expect(B.log.indexOf("POST /upload/image")).toBeLessThan(
      B.log.indexOf("POST /prompt"),
    );

    // A (main) only served the source file.
    expect(A.log).toContain("GET /view");
    expect(A.log).not.toContain("POST /prompt");
    const aq = (await (await fetch(`${A.url}/queue`)).json()) as {
      queue_running: unknown[];
    };
    expect(aq.queue_running).toHaveLength(0);

    // History / progress / output fetches look on B first.
    expect(candidateBackendUrls(result.prompt_id)[0]).toBe(B.url);
    expect(backendForSubfolder("adrift-b")).toBe("b");
  }, 30_000);
});
