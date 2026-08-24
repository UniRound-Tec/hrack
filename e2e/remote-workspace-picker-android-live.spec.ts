import { execFile } from "node:child_process";
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { launchApp } from "./helpers";

const execFileAsync = promisify(execFile);
const joinUrl = process.env.HRACK_REMOTE_WORKSPACE_JOIN_URL;
const adbExecutable = process.env.HRACK_ANDROID_ADB;
const appPackage =
  process.env.HRACK_ANDROID_APP_PACKAGE ?? "app.modplex.hrack.remote";
const uiDumpPath = "/sdcard/hrack-workspace-picker-window.xml";

function quoteRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function adb(...args: string[]): Promise<string> {
  if (!adbExecutable) throw new Error("HRACK_ANDROID_ADB is not configured");
  const result = await execFileAsync(adbExecutable, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function dumpUi(): Promise<string> {
  await adb("shell", "uiautomator", "dump", uiDumpPath);
  return adb("exec-out", "cat", uiDumpPath);
}

function nodeBounds(
  xml: string,
  attribute: "resource-id" | "text",
  value: string,
): [number, number] | null {
  const match = xml.match(
    new RegExp(
      `<node[^>]*${attribute}="${quoteRegex(value)}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    ),
  );
  if (!match) return null;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  // UIAutomator can expose a row already clipped underneath the fixed footer.
  // Wait until the text has a real visible rectangle before treating it as tappable.
  if (right - left < 10 || bottom - top < 20) return null;
  return [Math.round((left + right) / 2), Math.round((top + bottom) / 2)];
}

async function waitForUi(
  predicate: (xml: string) => boolean,
  label: string,
  timeoutMs = 45_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    latest = await dumpUi().catch(() => "");
    if (predicate(latest)) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  }
  throw new Error(`Timed out waiting for Android UI: ${label}`);
}

async function tapResource(resourceId: string): Promise<void> {
  const xml = await waitForUi(
    (candidate) => nodeBounds(candidate, "resource-id", resourceId) !== null,
    resourceId,
  );
  const point = nodeBounds(xml, "resource-id", resourceId);
  if (!point) throw new Error(`Android resource disappeared: ${resourceId}`);
  await adb("shell", "input", "tap", String(point[0]), String(point[1]));
}

async function tapVisibleText(text: string): Promise<void> {
  const xml = await dumpUi();
  const point = nodeBounds(xml, "text", text);
  if (!point) throw new Error(`Android text is not visible: ${text}`);
  await adb("shell", "input", "tap", String(point[0]), String(point[1]));
}

function scrollGesture(
  xml: string,
  forward = true,
): [number, number, number, number] {
  const screen = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
  const width = Number(screen?.[1] ?? 1080);
  const height = Number(screen?.[2] ?? 2400);
  const x = Math.round(width * 0.5);
  const lower = Math.round(height * 0.72);
  const upper = Math.round(height * 0.6);
  return forward ? [x, lower, x, upper] : [x, upper, x, lower];
}

async function scrollUntilText(text: string, maxSwipes = 90): Promise<string> {
  for (let attempt = 0; attempt <= maxSwipes; attempt += 1) {
    const xml = await dumpUi();
    if (nodeBounds(xml, "text", text)) return xml;
    if (attempt === maxSwipes) break;
    const [startX, startY, endX, endY] = scrollGesture(xml);
    await adb(
      "shell",
      "input",
      "swipe",
      String(startX),
      String(startY),
      String(endX),
      String(endY),
      "350",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  }
  throw new Error(`Android list never exposed real computer entry: ${text}`);
}

function localEntryRank(entry: Dirent): number {
  return entry.isDirectory() ? 0 : entry.isSymbolicLink() ? 2 : 1;
}

function localEntryIndex(directory: string, name: string): number {
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) =>
      localEntryRank(left) - localEntryRank(right) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const index = entries.findIndex((entry) => entry.name === name);
  if (index < 0)
    throw new Error(`Missing local gate fixture: ${join(directory, name)}`);
  return index;
}

function visibleWorkspaceIndices(xml: string): number[] {
  return [...xml.matchAll(/resource-id="workspace-entry-(\d+)"/g)].map(
    (match) => Number(match[1]),
  );
}

function workspaceEntryContains(
  xml: string,
  index: number,
  name: string,
): boolean {
  const marker = `resource-id="workspace-entry-${index}"`;
  const start = xml.indexOf(marker);
  if (start < 0) return false;
  const next = xml.indexOf(
    'resource-id="workspace-entry-',
    start + marker.length,
  );
  const entry = xml.slice(start, next < 0 ? undefined : next);
  return entry.includes(`text="${name}"`);
}

async function exposeWorkspaceEntry(
  directory: string,
  name: string,
  maxSwipes = 120,
): Promise<{ xml: string; resourceId: string }> {
  const index = localEntryIndex(directory, name);
  const resourceId = `workspace-entry-${index}`;
  for (let attempt = 0; attempt <= maxSwipes; attempt += 1) {
    const xml = await dumpUi();
    if (
      nodeBounds(xml, "resource-id", resourceId) &&
      nodeBounds(xml, "text", name) &&
      workspaceEntryContains(xml, index, name)
    ) {
      return { xml, resourceId };
    }
    if (attempt === maxSwipes) break;
    const visible = visibleWorkspaceIndices(xml);
    const first = visible.length > 0 ? Math.min(...visible) : -1;
    const last = visible.length > 0 ? Math.max(...visible) : -1;
    const forward =
      last < 0 || index > last || (index >= first && index === last);
    const [startX, startY, endX, endY] = scrollGesture(xml, forward);
    await adb(
      "shell",
      "input",
      "swipe",
      String(startX),
      String(startY),
      String(endX),
      String(endY),
      "550",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  }
  throw new Error(
    `Android list never exposed matching real computer entry: ${join(directory, name)}`,
  );
}

async function tapWorkspaceEntry(
  directory: string,
  name: string,
): Promise<void> {
  const { xml, resourceId } = await exposeWorkspaceEntry(directory, name);
  const point = nodeBounds(xml, "resource-id", resourceId);
  if (!point)
    throw new Error(`Android entry disappeared: ${join(directory, name)}`);
  await adb("shell", "input", "tap", String(point[0]), String(point[1]));
}

async function screenshot(testInfo: TestInfo, name: string): Promise<void> {
  const remotePath = `/sdcard/${name}`;
  await adb("shell", "screencap", "-p", remotePath);
  await adb("pull", remotePath, testInfo.outputPath(name));
}

async function connectHrack(page: Page, url: string): Promise<void> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate("settings"));
  await page.getByTestId("settings-category-remote").click();
  await page.getByTestId("settings-remote-url").fill(url);
  await page.getByTestId("settings-remote-connect").click();
  await page.getByTestId("settings-remote-confirm-accept").click();
  await expect(page.getByTestId("settings-remote-status")).toHaveAttribute(
    "data-remote-phase",
    "waiting-phone",
  );
}

async function startAndPairAndroid(url: string): Promise<void> {
  await adb("shell", "am", "start", "-W", "-n", `${appPackage}/.MainActivity`);
  await waitForUi(
    (xml) => nodeBounds(xml, "resource-id", "pairing-manual-toggle") !== null,
    "pairing screen",
  );
  await tapResource("pairing-manual-toggle");
  await tapResource("pairing-url");
  try {
    await adb("shell", "input", "text", url);
  } catch {
    throw new Error("Android failed to enter the pairing URL");
  }
  await adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await tapResource("pairing-connect");
}

test.describe("remote workspace picker Android live relay", () => {
  test.skip(
    !joinUrl || !adbExecutable,
    "set HRACK_REMOTE_WORKSPACE_JOIN_URL and HRACK_ANDROID_ADB",
  );

  test("browses the real desktop filesystem and launches Codex in the selected folder", async ({}, testInfo) => {
    test.skip(
      process.platform !== "win32",
      "current Android/Electron gate is Windows",
    );
    test.setTimeout(300_000);
    if (!joinUrl) throw new Error("missing existing public join URL");

    let app: ElectronApplication | undefined;
    try {
      await adb(
        "shell",
        "settings",
        "put",
        "system",
        "accelerometer_rotation",
        "0",
      );
      await adb("shell", "settings", "put", "system", "user_rotation", "0");
      // Release the phone seat before Electron joins the persistent public room.
      await adb("shell", "pm", "clear", appPackage);

      const launched = await launchApp({
        createDefaultTerminal: false,
        cliFixture: false,
      });
      app = launched.app;
      const hrackPage = launched.window;

      const codex = await hrackPage.evaluate(async () => {
        const report = await window.cliApi.scan(true);
        const launchable = report.launchable.find(
          (candidate) => candidate.definition.id === "codex",
        );
        const installation = launchable?.installations.find(
          (candidate) =>
            candidate.runtime.kind === "host" &&
            candidate.runtime.platform === "windows",
        );
        return installation
          ? {
              id: installation.id,
              executable: installation.resolvedExecutable,
              version: installation.version ?? null,
            }
          : null;
      });
      expect(codex).not.toBeNull();

      await connectHrack(hrackPage, joinUrl);
      await startAndPairAndroid(joinUrl);
      await waitForUi(
        (xml) =>
          nodeBounds(xml, "resource-id", "sessions-create") !== null &&
          nodeBounds(xml, "resource-id", "sessions-screen") !== null,
        "sessions screen backed by the real desktop catalog",
      );

      await tapResource("sessions-create");
      await waitForUi(
        (xml) =>
          nodeBounds(xml, "resource-id", "creation-cli-codex") !== null &&
          nodeBounds(xml, "resource-id", "creation-workspace-browse") !== null,
        "creation form",
      );
      await tapResource("creation-cli-codex");
      await waitForUi(
        (xml) => xml.includes("Windows") && xml.includes(codex?.version ?? ""),
        "real Windows Codex installation",
      );
      await tapResource("creation-installation-0");
      await tapResource("creation-workspace-browse");

      await waitForUi(
        (xml) =>
          nodeBounds(xml, "resource-id", "workspace-picker") !== null &&
          nodeBounds(xml, "text", "Home") !== null,
        "remote computer roots",
      );
      await tapVisibleText("Home");

      const home = process.env.USERPROFILE ?? "C:\\Users\\Jesse";
      await waitForUi(
        (xml) => xml.includes(home) && xml.includes("选择工作区"),
        "real Windows home directory",
      );
      await tapWorkspaceEntry(home, "Desktop");
      const desktop = join(home, "Desktop");
      await waitForUi((xml) => xml.includes(desktop), "real Desktop directory");
      await tapWorkspaceEntry(desktop, "vibing-ws");
      const workspaceParent = join(desktop, "vibing-ws");
      await waitForUi(
        (xml) => xml.includes(workspaceParent),
        "real workspace parent directory",
      );
      await tapWorkspaceEntry(workspaceParent, "vibing");
      await waitForUi(
        (xml) => xml.includes(process.cwd()),
        "real repository directory",
      );

      await exposeWorkspaceEntry(process.cwd(), "package.json");
      await screenshot(testInfo, "workspace-picker-real-files.png");
      await tapResource("workspace-picker-select");
      await waitForUi(
        (xml) =>
          nodeBounds(xml, "resource-id", "creation-workspace") !== null &&
          xml.includes(process.cwd()),
        "selected desktop workspace returned to the creation form",
      );

      await scrollUntilText("在电脑上启动", 12);
      await tapVisibleText("在电脑上启动");
      await waitForUi(
        (xml) =>
          nodeBounds(xml, "resource-id", "terminal-screen") !== null &&
          nodeBounds(xml, "resource-id", "terminal-back") !== null,
        "real Codex terminal opened on Android",
        90_000,
      );

      const created = await hrackPage.evaluate(async (workspace) => {
        const active = await window.agentApi.listActive();
        const recoverable = await window.ptyApi.listRecoverable();
        const pty = recoverable.find(
          (candidate) =>
            candidate.kind === "agent" &&
            candidate.cwd.toLocaleLowerCase() ===
              workspace.toLocaleLowerCase() &&
            candidate.agentSelection?.installationId,
        );
        const session = pty
          ? active.find((candidate) => candidate.terminalId === pty.terminalId)
          : undefined;
        return pty && session
          ? {
              adapterId: session.adapterId,
              cwd: pty.cwd,
              exited: pty.exited,
              ptyId: pty.ptyId,
              drive: await window.remoteApi.getDriveState(),
            }
          : null;
      }, process.cwd());
      expect(created).toMatchObject({
        adapterId: "codex",
        cwd: process.cwd(),
        exited: false,
        drive: { phase: "driven" },
      });
      if (!created) throw new Error("real Codex PTY disappeared");
      await expect
        .poll(
          () =>
            hrackPage.evaluate(async (ptyId) => {
              const history = await window.ptyApi.getHistory(ptyId);
              return history?.retainedOutputBytes ?? 0;
            }, created.ptyId),
          {
            timeout: 60_000,
            message: "real Codex must emit authoritative PTY output",
          },
        )
        .toBeGreaterThan(0);

      await tapResource("terminal-hud-details");
      await waitForUi(
        (xml) => {
          const parsed = xml.match(/(?:已解析\s*)?(\d+) B/);
          return parsed !== null && Number(parsed[1]) > 0;
        },
        "Android terminal parsed real Codex PTY bytes",
        60_000,
      );
      await tapResource("terminal-hud-details");
      await new Promise((resolveWait) => setTimeout(resolveWait, 750));
      await screenshot(testInfo, "workspace-picker-real-codex-terminal.png");
    } finally {
      await app?.close().catch(() => {});
      await adb(
        "shell",
        "settings",
        "put",
        "system",
        "accelerometer_rotation",
        "1",
      ).catch(() => {});
    }
  });
});
