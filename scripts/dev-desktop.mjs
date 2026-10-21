import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = process.cwd();
const compiledMainDirectory = path.join(projectRoot, "dist", "main", "main");
const electronExecutable = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

let desktop;
let restartTimer;
let restartRequested = false;
let stopping = false;

function startDesktop() {
  restartRequested = false;
  // Electron 必须以自身运行时启动；若环境中残留 ELECTRON_RUN_AS_NODE=1，
  // 会让 electron.exe 退化为纯 Node 模式，导致 require('electron').app 为
  // undefined、主进程崩溃、"程序启动不起来"。启动前显式清除该变量。
  const desktopEnv = { ...process.env };
  delete desktopEnv.ELECTRON_RUN_AS_NODE;
  const desktopArgs = ["."];
  const devUserDataDirectory = desktopEnv.CONTENTFERRY_DEV_USER_DATA_DIR?.trim();
  if (devUserDataDirectory) desktopArgs.push(`--user-data-dir=${path.resolve(devUserDataDirectory)}`);
  const devToolsPortValue = desktopEnv.CONTENTFERRY_DEV_CDP_PORT?.trim();
  if (devToolsPortValue) {
    const devToolsPort = Number(devToolsPortValue);
    if (!Number.isInteger(devToolsPort) || devToolsPort < 1024 || devToolsPort > 65535) {
      throw new Error("CONTENTFERRY_DEV_CDP_PORT must be an integer between 1024 and 65535.");
    }
    // Temporary GUI acceptance only: bind CDP to loopback and require an
    // explicit environment opt-in so normal developer launches expose no port.
    desktopArgs.push(
      `--remote-debugging-port=${devToolsPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-allow-origins=http://127.0.0.1:${devToolsPort}`
    );
  }
  desktop = spawn(electronExecutable, desktopArgs, {
    cwd: projectRoot,
    env: {
      ...desktopEnv,
      CONTENTFERRY_DEV_SERVER_URL: "http://127.0.0.1:5175"
    },
    stdio: "inherit",
    windowsHide: false
  });
  desktop.once("exit", (code, signal) => {
    desktop = undefined;
    if (stopping) return;
    if (restartRequested) {
      setTimeout(startDesktop, 250);
      return;
    }
    process.exitCode = code ?? (signal ? 1 : 0);
    process.exit();
  });
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!desktop) return;
    restartRequested = true;
    desktop.kill();
  }, 450);
}

const watcher = fs.watch(compiledMainDirectory, { recursive: true }, (_event, fileName) => {
  if (fileName?.endsWith(".js") || fileName?.endsWith(".js.map")) scheduleRestart();
});

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  watcher.close();
  desktop?.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);

startDesktop();
