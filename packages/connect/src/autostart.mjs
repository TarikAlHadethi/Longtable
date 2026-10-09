// Start the connection with the computer, with no window. Only ever set up after the person pressed Send on the
// Connect message that says so, and removed again by `longtable disconnect`.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const startupFile = () => join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Longtable.vbs");
const agentFile = () => join(homedir(), "Library", "LaunchAgents", "chat.longtable.connection.plist");
const unitFile = () => join(homedir(), ".config", "systemd", "user", "longtable.service");

export function enableAutostart(nodePath, binPath) {
  if (process.platform === "win32") {
    const q = (s) => s.replace(/"/g, '""');
    writeFileSync(startupFile(), `CreateObject("Wscript.Shell").Run """${q(nodePath)}"" ""${q(binPath)}"" run", 0, False\r\n`);
    return startupFile();
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
    return agentFile();
  }
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unitFile(), `[Unit]\nDescription=Longtable connection\n\n[Service]\nExecStart=${nodePath} ${binPath} run\nRestart=always\n\n[Install]\nWantedBy=default.target\n`);
  return unitFile();
}

export function disableAutostart() {
  for (const f of [startupFile(), agentFile(), unitFile()]) if (existsSync(f)) rmSync(f, { force: true });
}
