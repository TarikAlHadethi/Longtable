// Start the connection with the computer, with no window. Only ever set up after the person pressed Send on the
// Connect message that says so, and removed again by `longtable disconnect`.
//
// Windows: a per-user task in Task Scheduler, not the Startup folder. Claude Desktop is a packaged app, and files
// written from inside it into AppData (the Startup folder included) are kept in its private folder, where Windows
// never looks at sign-in. Task Scheduler is a service outside the app, so the task is real, and it starts the
// connection outside the app too. The task runs a copy of the connection kept in ~/.longtable/app, since the copy
// that ran `connect` may itself live somewhere only the app can see.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { home } from "./store.mjs";

export const TASK = "Longtable connection";
const legacyStartup = () => join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Longtable.vbs");
const agentFile = () => join(homedir(), "Library", "LaunchAgents", "chat.longtable.connection.plist");
const unitFile = () => join(homedir(), ".config", "systemd", "user", "longtable.service");

function powershell(script, env = {}) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, ...env },
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`Task Scheduler said no: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  return r.stdout;
}

// Copy the connection (its command and code; it needs nothing installed to run) to a place every program sees.
export function installCopy(binPath) {
  const pkg = dirname(dirname(binPath));
  const app = join(home, "app");
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  for (const part of ["bin", "src", "package.json"]) cpSync(join(pkg, part), join(app, part), { recursive: true });
  return join(app, "bin", "longtable.mjs");
}

// The task runs this script, which starts Node with no window.
function writeStarter(nodePath, binPath) {
  const q = (s) => s.replace(/"/g, '""');
  const file = join(home, "start.vbs");
  writeFileSync(file, `CreateObject("Wscript.Shell").Run """${q(nodePath)}"" ""${q(binPath)}"" run", 0, False\r\n`);
  return file;
}

export function registerTask(name, starter) {
  powershell(
    "$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('\"' + $env:LT_STARTER + '\"'); " +
      "$t = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name); " +
      "$p = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited; " +
      "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable; " +
      "Register-ScheduledTask -TaskName $env:LT_TASK -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null",
    { LT_TASK: name, LT_STARTER: starter },
  );
}

export function startTask(name) {
  powershell("Start-ScheduledTask -TaskName $env:LT_TASK", { LT_TASK: name });
}

export function removeTask(name) {
  try {
    powershell("Unregister-ScheduledTask -TaskName $env:LT_TASK -Confirm:$false -ErrorAction Stop", { LT_TASK: name });
  } catch {}
}

export function taskExists(name) {
  try {
    return powershell("if (Get-ScheduledTask -TaskName $env:LT_TASK -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }", { LT_TASK: name }).trim() === "yes";
  } catch {
    return false;
  }
}

// Returns how the connection will start: on Windows the task also starts it now, outside whatever ran `connect`.
export function enableAutostart(nodePath, binPath) {
  if (process.platform === "win32") {
    const copy = installCopy(binPath);
    registerTask(TASK, writeStarter(nodePath, copy));
    rmSync(legacyStartup(), { force: true });
    startTask(TASK);
    return { started: true, where: `Task Scheduler: ${TASK}` };
  }
  if (process.platform === "darwin") {
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(agentFile(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>chat.longtable.connection</string>
<key>ProgramArguments</key><array><string>${nodePath}</string><string>${binPath}</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
`);
    return { started: false, where: agentFile() };
  }
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unitFile(), `[Unit]\nDescription=Longtable connection\n\n[Service]\nExecStart=${nodePath} ${binPath} run\nRestart=always\n\n[Install]\nWantedBy=default.target\n`);
  return { started: false, where: unitFile() };
}

export function disableAutostart() {
  if (process.platform === "win32") {
    removeTask(TASK);
    rmSync(join(home, "start.vbs"), { force: true });
  }
  for (const f of [legacyStartup(), agentFile(), unitFile()]) if (existsSync(f)) rmSync(f, { force: true });
}
