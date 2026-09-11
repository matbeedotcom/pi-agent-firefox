import { createAgentSession, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
const tmpAgent = "/tmp/probe/pi-agent";
const tmpCwd = "/tmp/probe/cwd";
import { mkdirSync } from "node:fs";
mkdirSync(tmpCwd, { recursive: true });

// 1. ModelRuntime with empty agent dir
const rt = await ModelRuntime.create({ authPath: tmpAgent + "/auth.json", modelsPath: tmpAgent + "/models.json" });
console.log("providers:", rt.getProviders().map(p => p.id).slice(0, 8));
const avail = await rt.getAvailable();
console.log("available models:", avail.length, avail.slice(0,3).map(m => m.provider + "/" + m.id));

// 2. createAgentSession with no model, in-memory session
try {
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: tmpCwd,
    agentDir: tmpAgent,
    modelRuntime: rt,
    sessionManager: SessionManager.inMemory(tmpCwd),
    settingsManager: (await import("@earendil-works/pi-coding-agent")).SettingsManager.inMemory(),
  });
  console.log("session ok. id:", session.sessionId, "model:", session.model ? (session.model.provider + "/" + session.model.id) : "undefined", "fallback:", modelFallbackMessage);
  session.dispose();
} catch (e) {
  console.log("createSession error:", e.message.slice(0, 300));
}

// 3. persistent session creation + list
try {
  const sm = SessionManager.create(tmpCwd);
  const { session } = await createAgentSession({ cwd: tmpCwd, agentDir: tmpAgent, modelRuntime: rt, sessionManager: sm, settingsManager: (await import("@earendil-works/pi-coding-agent")).SettingsManager.inMemory() });
  console.log("persistent session id:", session.sessionId, "file:", session.sessionFile);
  session.dispose();
  const list = await SessionManager.listAll();
  console.log("listAll count:", list.length, "first:", list[0] && { id: list[0].id, cwd: list[0].cwd, modified: list[0].modified, firstMessage: (list[0].firstMessage||"").slice(0,30) });
} catch (e) {
  console.log("persistent error:", e.message.slice(0, 300));
}
