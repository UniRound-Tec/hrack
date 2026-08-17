import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { launchApp } from "./helpers";

interface FloatingInspect {
  state: {
    enabled: boolean;
    selectedRendererId: string;
    activeRendererId: string | null;
    activeError: string | null;
    attentionEffectEnabled: boolean;
    scale: number;
  };
  window: {
    bounds: { width: number; height: number };
    shapeRectCount: number;
    preferences: {
      contextIsolation: boolean;
      nodeIntegration: boolean;
      sandbox: boolean;
      webSecurity: boolean;
    };
    url: string;
  } | null;
}

function inspectFloating(app: ElectronApplication): Promise<FloatingInspect> {
  return app.evaluate(() =>
    (
      globalThis as unknown as {
        __hrackMainDebug: { floatingWindowInspect(): FloatingInspect };
      }
    ).__hrackMainDebug.floatingWindowInspect(),
  );
}

async function floatingPage(
  app: ElectronApplication,
  matches: (url: string) => boolean,
): Promise<Page> {
  await expect
    .poll(() => app.windows().some((candidate) => matches(candidate.url())), {
      timeout: 15_000,
    })
    .toBe(true);
  const page = app.windows().find((candidate) => matches(candidate.url()));
  if (!page) throw new Error("floating page disappeared");
  return page;
}

function projection(
  status: "working" | "needs-you" | "done" | "error",
  lastSeq: number,
) {
  return {
    sessionId: "floating-fixture",
    terminalId: "terminal-floating-fixture",
    adapterId: "fixture",
    name: "Floating fixture",
    status,
    statusConfidence: "high",
    observerHealth: "healthy",
    detail: status,
    pendingAttentionCount: status === "needs-you" ? 1 : 0,
    activeTurnId: `turn-${lastSeq}`,
    activeToolCount: status === "working" ? 1 : 0,
    correlation: {
      lastTurnOutcome:
        status === "done" ? "completed" : status === "error" ? "failed" : undefined,
    },
    lastActivityAt: Date.now(),
    lastSeq,
  };
}

async function publish(
  app: ElectronApplication,
  value: ReturnType<typeof projection>,
): Promise<void> {
  await app.evaluate((_electron, payload) => {
    (
      globalThis as unknown as {
        __hrackMainDebug: {
          floatingWindowPublishProjection(projection: unknown): boolean;
        };
      }
    ).__hrackMainDebug.floatingWindowPublishProjection(payload);
  }, value);
}

test("built-in renderer uses the sandbox API and surfaces attention transitions", async () => {
  const { app, window } = await launchApp({ createDefaultTerminal: false });
  try {
    await window.evaluate(() => window.floatingWindowApi.setEnabled(true));
    const floating = await floatingPage(
      app,
      (url) => new URL(url).searchParams.get("surface") === "floating",
    );
    await expect(floating.getByTestId("floating-window")).toBeVisible();

    const inspect = await inspectFloating(app);
    expect(inspect.state.activeRendererId).toBe("builtin/default");
    expect(inspect.window?.preferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(
      await floating.evaluate(() => ({
        rendererApi: typeof window.hrackFloating,
        broadAgentApi: typeof window.agentApi,
        ptyApi: typeof window.ptyApi,
        nodeRequire: typeof (globalThis as Record<string, unknown>)["require"],
      })),
    ).toEqual({
      rendererApi: "object",
      broadAgentApi: "undefined",
      ptyApi: "undefined",
      nodeRequire: "undefined",
    });

    await publish(app, projection("working", 1));
    await publish(app, projection("needs-you", 2));
    await expect(floating.getByTestId("floating-window")).toHaveAttribute(
      "data-attention",
      "persistent",
    );

    await publish(app, projection("working", 3));
    await publish(app, projection("done", 4));
    await expect(floating.getByTestId("floating-window")).toHaveAttribute(
      "data-attention",
      "complete",
    );

    await window.evaluate(() =>
      window.floatingWindowApi.setAttentionEffectEnabled(false),
    );
    await publish(app, projection("error", 5));
    await expect(floating.getByTestId("floating-window")).toHaveAttribute(
      "data-attention",
      "none",
    );
  } finally {
    await app.close().catch(() => {});
  }
});

test("floating renderer size is persisted and uniformly applied", async () => {
  const { app, window } = await launchApp({ createDefaultTerminal: false });
  try {
    await window.evaluate(async () => {
      await window.floatingWindowApi.setEnabled(true);
      await window.floatingWindowApi.setScale(0.75);
    });
    await expect
      .poll(async () => (await inspectFloating(app)).window?.bounds)
      .toMatchObject({ width: 186 });
    expect((await inspectFloating(app)).state.scale).toBe(0.75);

    await window.evaluate(() => window.floatingWindowApi.setScale(1.4));
    await expect
      .poll(async () => (await inspectFloating(app)).window?.bounds)
      .toMatchObject({ width: 347 });
    expect((await inspectFloating(app)).state.scale).toBe(1.4);
  } finally {
    await app.close().catch(() => {});
  }
});

test("built-in Live2D renderer follows real turn projections", async () => {
  const { app, window } = await launchApp({ createDefaultTerminal: false });
  try {
    await window.evaluate(async () => {
      await window.floatingWindowApi.setRenderer("builtin/live2d-mao");
      await window.floatingWindowApi.setEnabled(true);
    });
    const live2d = await floatingPage(
      app,
      (url) => url.startsWith("file:") && url.includes("live2d-mao"),
    );
    await expect(live2d.locator("html")).toHaveAttribute(
      "data-live2d-ready",
      "true",
      { timeout: 30_000 },
    );
    expect((await inspectFloating(app)).state.activeRendererId).toBe(
      "builtin/live2d-mao",
    );
    await expect
      .poll(async () => (await inspectFloating(app)).window?.bounds)
      .toMatchObject({ width: 420, height: 620 });

    await publish(app, projection("working", 41));
    await expect(live2d.locator("body")).toHaveAttribute(
      "data-turn-state",
      "working",
    );
    await expect(live2d.locator("body")).toHaveAttribute(
      "data-turn-id",
      "turn-41",
    );
    await expect(live2d.locator("#session-detail")).toContainText(
      "1 个工具运行中",
    );

    await publish(app, projection("needs-you", 42));
    await expect(live2d.locator("body")).toHaveAttribute(
      "data-turn-state",
      "needs-you",
    );
    await expect(live2d.locator("#live2d-turn-status")).toContainText(
      "需要你的确认",
    );
    expect(await live2d.pageErrors()).toEqual([]);
    if (process.env["HRACK_CAPTURE_BUILTIN_LIVE2D"]) {
      const captureDir = resolve(__dirname, "../.dev-shots");
      mkdirSync(captureDir, { recursive: true });
      await live2d.screenshot({
        path: join(captureDir, "builtin-live2d-turn.png"),
        omitBackground: true,
      });
    }
  } finally {
    await app.close().catch(() => {});
  }
});

test("user renderer hot reloads in the same sandbox and falls back when invalid", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "hrack-floating-e2e-"));
  const rendererDir = join(userDataDir, "floating-renderers", "sample");
  const modelDir = join(rendererDir, "models");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "fixture.model3.json"),
    JSON.stringify({ name: "fixture-model" }),
  );
  writeFileSync(join(modelDir, "fixture.moc3"), new Uint8Array([1, 2, 3, 4]));
  writeFileSync(
    join(modelDir, "fixture.wasm"),
    new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  writeFileSync(
    join(rendererDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "sample",
      name: "Sample renderer",
      entry: "index.html",
    }),
  );
  const writeRenderer = (label: string): void => {
    writeFileSync(
      join(rendererDir, "index.html"),
      `<!doctype html><meta charset="utf-8"><body>${label}<output id="sandbox"></output><output id="local-asset">loading</output><output id="binary-asset">loading</output><output id="wasm-asset">loading</output><output id="remote-asset">loading</output><script>document.querySelector('#sandbox').textContent=[typeof window.hrackFloating,typeof window.ptyApi,typeof require].join('|');fetch('./models/fixture.model3.json').then((response)=>response.json()).then((model)=>document.querySelector('#local-asset').textContent=model.name).catch(()=>document.querySelector('#local-asset').textContent='blocked');fetch('./models/fixture.moc3').then(async(response)=>document.querySelector('#binary-asset').textContent=response.headers.get('content-type')+':'+(await response.arrayBuffer()).byteLength).catch(()=>document.querySelector('#binary-asset').textContent='blocked');WebAssembly.instantiateStreaming(fetch('./models/fixture.wasm')).then(()=>document.querySelector('#wasm-asset').textContent='ready').catch(()=>document.querySelector('#wasm-asset').textContent='blocked');fetch('https://example.com/live2d.model3.json').then(()=>document.querySelector('#remote-asset').textContent='allowed').catch(()=>document.querySelector('#remote-asset').textContent='blocked')</script>`,
    );
  };
  writeRenderer("custom-v1");

  const { app, window } = await launchApp({
    userDataDir,
    createDefaultTerminal: false,
  });
  try {
    await window.evaluate(async () => {
      await window.floatingWindowApi.refreshRenderers();
      await window.floatingWindowApi.setRenderer("user/sample");
      await window.floatingWindowApi.setEnabled(true);
    });
    let custom = await floatingPage(app, (url) =>
      url.startsWith("hrack-floating://sample/"),
    );
    await expect(custom.locator("body")).toContainText("custom-v1");
    await expect(custom.locator("#sandbox")).toHaveText(
      "object|undefined|undefined",
    );
    await expect(custom.locator("#local-asset")).toHaveText("fixture-model");
    await expect(custom.locator("#binary-asset")).toHaveText(
      "application/octet-stream:4",
    );
    await expect(custom.locator("#wasm-asset")).toHaveText("ready");
    await expect(custom.locator("#remote-asset")).toHaveText("blocked");

    writeRenderer("custom-v2");
    await expect
      .poll(
        async () => {
          const current = app
            .windows()
            .find((candidate) =>
              candidate.url().startsWith("hrack-floating://sample/"),
            );
          return current
            ? current
                .locator("body")
                .textContent()
                .catch(() => "")
            : "";
        },
        { timeout: 15_000 },
      )
      .toContain("custom-v2");
    custom = await floatingPage(app, (url) =>
      url.startsWith("hrack-floating://sample/"),
    );
    await expect(custom.locator("#sandbox")).toHaveText(
      "object|undefined|undefined",
    );
    await expect(custom.locator("#local-asset")).toHaveText("fixture-model");

    writeFileSync(join(rendererDir, "manifest.json"), "{ broken json");
    await expect
      .poll(async () => (await inspectFloating(app)).state.activeRendererId, {
        timeout: 15_000,
      })
      .toBe("builtin/default");
    const fallback = await inspectFloating(app);
    expect(fallback.state.selectedRendererId).toBe("user/sample");
    expect(fallback.state.activeError).toContain("已回退");
  } finally {
    await app.close().catch(() => {});
  }
});

test("Sunny Buddy example renders session moods and respects the effect toggle", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "hrack-sunny-e2e-"));
  const rendererRoot = join(userDataDir, "floating-renderers", "sunny-buddy");
  mkdirSync(join(userDataDir, "floating-renderers"), { recursive: true });
  cpSync(
    resolve(__dirname, "../examples/floating-renderers/sunny-buddy"),
    rendererRoot,
    { recursive: true },
  );

  const { app, window } = await launchApp({
    userDataDir,
    createDefaultTerminal: false,
  });
  try {
    await window.evaluate(async () => {
      await window.floatingWindowApi.refreshRenderers();
      await window.floatingWindowApi.setRenderer("user/sunny-buddy");
      await window.floatingWindowApi.setEnabled(true);
    });
    const sunny = await floatingPage(app, (url) =>
      url.startsWith("hrack-floating://sunny-buddy/"),
    );
    await expect(sunny.locator("#buddy")).toBeVisible();
    await expect
      .poll(() =>
        sunny
          .locator("#mascot")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);

    await publish(app, projection("working", 1));
    await expect(sunny.locator("#buddy")).toHaveAttribute(
      "data-mood",
      "working",
    );
    await publish(app, projection("needs-you", 2));
    await expect(sunny.locator("#buddy")).toHaveAttribute(
      "data-mood",
      "needs-you",
    );
    await expect(sunny.locator("#attention-badge")).toBeVisible();
    await expect
      .poll(async () => (await inspectFloating(app)).window?.bounds)
      .toMatchObject({ width: 340, height: 430 });
    await expect(sunny.locator(".session-chip")).toBeVisible();
    if (process.platform === "win32" || process.platform === "linux") {
      await expect
        .poll(
          async () => (await inspectFloating(app)).window?.shapeRectCount ?? 0,
        )
        .toBeGreaterThan(100);
    }
    if (process.env["HRACK_CAPTURE_SUNNY"]) {
      const captureDir = resolve(__dirname, "../.dev-shots");
      mkdirSync(captureDir, { recursive: true });
      await sunny.screenshot({
        path: join(captureDir, "sunny-buddy.png"),
      });
    }

    await window.evaluate(() =>
      window.floatingWindowApi.setAttentionEffectEnabled(false),
    );
    await publish(app, projection("done", 3));
    await expect(sunny.locator("#buddy")).toHaveAttribute(
      "data-effects",
      "off",
    );
    await expect(sunny.locator("#buddy")).not.toHaveClass(/attention-burst/);

    await window.evaluate(() =>
      window.floatingWindowApi.setAttentionEffectEnabled(true),
    );
    await expect(sunny.locator("#buddy")).not.toHaveClass(/attention-burst/);
    await publish(app, projection("working", 4));
    await publish(app, projection("done", 5));
    await expect(sunny.locator("#buddy")).toHaveClass(/attention-burst/);
  } finally {
    await app.close().catch(() => {});
  }
});

test("settings copies the built-in renderer creation Skill without exposing its body", async () => {
  const { app, window } = await launchApp({ createDefaultTerminal: false });
  try {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("clipboard:write-text");
      ipcMain.handle("clipboard:write-text", (_event, text: unknown) => {
        (globalThis as Record<string, unknown>)["__hrackCopiedSkill"] = text;
      });
    });

    await window.getByTestId("titlebar-settings").click();
    const settings = window.getByTestId("settings-page");
    const copy = window.getByTestId("settings-floating-renderer-copy-skill");
    await expect(settings).toBeVisible();
    await expect(copy).toBeVisible();
    await expect(settings).not.toContainText("interface FloatingRendererApi");
    if (process.env["HRACK_CAPTURE_FLOATING_SETTINGS"]) {
      const captureDir = resolve(__dirname, "../.dev-shots");
      mkdirSync(captureDir, { recursive: true });
      await settings.screenshot({
        path: join(captureDir, "floating-renderer-settings.png"),
      });
    }

    await copy.click();
    const copied = await app.evaluate(() =>
      String(
        (globalThis as Record<string, unknown>)["__hrackCopiedSkill"] ?? "",
      ),
    );
    expect(copied).toContain("name: create-hrack-floating-renderer");
    expect(copied).toContain("## Live2D implementation");
    expect(copied).toContain("activeTurnId");
    expect(copied).toContain("60%–160%");
    expect(copied).toContain("do not synthesize pointer events");
    await expect(copy).toContainText(/已复制|Copied|コピー済み|복사됨|已複製/);
  } finally {
    await app.close().catch(() => {});
  }
});

test("local official Live2D model renders and animates offline", async () => {
  const rendererSource = process.env["HRACK_LIVE2D_RENDERER"];
  test.skip(
    !rendererSource || !existsSync(rendererSource),
    "Set HRACK_LIVE2D_RENDERER to a licensed local renderer fixture",
  );

  const userDataDir = mkdtempSync(join(tmpdir(), "hrack-live2d-e2e-"));
  const rendererRoot = join(
    userDataDir,
    "floating-renderers",
    "live2d-mao-smoke",
  );
  mkdirSync(join(userDataDir, "floating-renderers"), { recursive: true });
  cpSync(rendererSource!, rendererRoot, { recursive: true });

  const { app, window } = await launchApp({
    userDataDir,
    createDefaultTerminal: false,
  });
  try {
    await window.evaluate(async () => {
      await window.floatingWindowApi.refreshRenderers();
      await window.floatingWindowApi.setRenderer("user/live2d-mao-smoke");
      await window.floatingWindowApi.setEnabled(true);
    });
    const live2d = await floatingPage(app, (url) =>
      url.startsWith("hrack-floating://live2d-mao-smoke/"),
    );
    await expect(live2d.locator("html")).toHaveAttribute(
      "data-live2d-ready",
      "true",
      { timeout: 30_000 },
    );
    await expect(live2d.locator("#live2d-test-status")).toContainText(
      "Live2D 已运行",
    );
    expect(
      await live2d.evaluate(async () => {
        const response = await fetch("./Resources/Mao/Mao.moc3");
        const buffer = await response.arrayBuffer();
        return {
          core: typeof (window as unknown as Record<string, unknown>)[
            "Live2DCubismCore"
          ],
          webgl2: Boolean(
            document.querySelector("canvas")?.getContext("webgl2"),
          ),
          mocStatus: response.status,
          mocBytes: buffer.byteLength,
        };
      }),
    ).toEqual({
      core: "object",
      webgl2: true,
      mocStatus: 200,
      mocBytes: 879_680,
    });
    expect(await live2d.pageErrors()).toEqual([]);

    const before = PNG.sync.read(
      await live2d.screenshot({ omitBackground: true }),
    );
    await live2d.waitForTimeout(750);
    const afterBuffer = await live2d.screenshot({ omitBackground: true });
    const after = PNG.sync.read(afterBuffer);
    let changedPixels = 0;
    for (let index = 0; index < before.data.length; index += 4) {
      const difference =
        Math.abs(before.data[index] - after.data[index]) +
        Math.abs(before.data[index + 1] - after.data[index + 1]) +
        Math.abs(before.data[index + 2] - after.data[index + 2]) +
        Math.abs(before.data[index + 3] - after.data[index + 3]);
      if (difference > 20) changedPixels++;
    }
    expect(changedPixels).toBeGreaterThan(500);

    const captureDir = resolve(__dirname, "../.dev-shots");
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, "live2d-mao-smoke.png"), afterBuffer);
  } finally {
    await app.close().catch(() => {});
  }
});
