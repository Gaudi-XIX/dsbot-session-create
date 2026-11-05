// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/autoresume.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";

// src/core.ts
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var PROMPT_TIMEOUT_MS = 30000;
var HISTORY_TIMEOUT_MS = 20000;
var SESSION_OPTION_TIMEOUT_MS = 1e4;
var MESSAGE_TIMEOUT_MS = 1e4;
var MESSAGE_CLIP = 2000;
var MESSAGES_MAX = 200;
var MESSAGES_DEFAULT = 40;
function pickService(ctx, name) {
  try {
    const direct = ctx?.[name];
    if (direct !== undefined && direct !== null)
      return direct;
  } catch {}
  try {
    return ctx?.get?.(name);
  } catch {
    return;
  }
}
function resolveServices(ctx) {
  return {
    get: (name) => safeGet(ctx, name),
    tools: pickService(ctx, "tools"),
    sessionController: pickService(ctx, "sessionController"),
    sessionTitle: pickService(ctx, "sessionTitle"),
    workspaceRegistry: pickService(ctx, "workspaceRegistry"),
    agentPresets: pickService(ctx, "agentPresets"),
    commands: pickService(ctx, "commands"),
    approval: pickService(ctx, "approval"),
    permissionPresets: pickService(ctx, "permissionPresets")
  };
}
function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return;
  }
}

class SessionCreateError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SessionCreateError";
    this.code = code;
  }
}
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function preflight(ctx) {
  const missing = [];
  if (typeof ctx?.tools?.register !== "function")
    missing.push("tools.register");
  if (typeof ctx?.sessionController?.create !== "function")
    missing.push("sessionController.create");
  if (typeof ctx?.sessionController?.prompt !== "function")
    missing.push("sessionController.prompt");
  if (typeof ctx?.sessionController?.resolveAgent !== "function")
    missing.push("sessionController.resolveAgent");
  if (typeof ctx?.sessionTitle?.rename !== "function")
    missing.push("sessionTitle.rename");
  if (typeof ctx?.workspaceRegistry?.get !== "function")
    missing.push("workspaceRegistry.get");
  if (typeof ctx?.workspaceRegistry?.archiveSession !== "function")
    missing.push("workspaceRegistry.archiveSession");
  return missing;
}
function preflightRead(ctx) {
  const missing = [];
  if (typeof ctx?.sessionController?.resolveAgent !== "function")
    missing.push("sessionController.resolveAgent");
  if (typeof ctx?.sessionController?.page !== "function")
    missing.push("sessionController.page");
  return missing;
}
function preflightOptions(ctx) {
  const missing = [];
  if (typeof ctx?.agentPresets?.list !== "function")
    missing.push("agentPresets.list");
  if (typeof ctx?.commands?.execute !== "function")
    missing.push("commands.execute");
  return missing;
}
function validate(args) {
  const title = (args?.title ?? "").trim();
  const prompt = (args?.prompt ?? "").trim();
  const folder = args?.folder?.trim() || undefined;
  const workspace = args?.workspace?.trim() || undefined;
  if (title === "")
    throw new SessionCreateError("missing-title", "a title is required; no Session was made.");
  if (prompt === "")
    throw new SessionCreateError("missing-prompt", "a prompt is required; no Session was made.");
  if (folder !== undefined && workspace !== undefined) {
    throw new SessionCreateError("two-placements", "give either folder or workspace, not both; no Session was made.");
  }
  if (folder === undefined && workspace === undefined) {
    throw new SessionCreateError("no-placement", "give exactly one of folder or workspace; no Session was made.");
  }
  return { title, prompt, folder, workspace };
}
var RESTRICTIVE_PERMISSIONS = ["read-only", "workspace-write"];
var FULL_PERMISSION = "danger-full-access";
var AUTO_PERMISSION = "auto";
var AUTO_APPROVAL_POLICY = "never";
function autoPresetState(ctx) {
  const names = ctx.permissionPresets?.names;
  if (!Array.isArray(names))
    return "unknown";
  return names.some((name) => String(name).trim().toLowerCase() === AUTO_PERMISSION) ? "yes" : "no";
}
function resolveDefaultPermission(ctx, options) {
  if (options.permission !== undefined) {
    if (options.permission.toLowerCase() === AUTO_PERMISSION && autoPresetState(ctx) === "no") {
      throw new SessionCreateError("host-missing", "this harness lists no `auto` permission preset (auto review is off or not installed); no Session was made.");
    }
    return;
  }
  if (typeof ctx.commands?.execute !== "function") {
    return "this harness has no commands.execute, so no permission preset was set; the Session runs at the host default.";
  }
  options.permission = FULL_PERMISSION;
  return 'the `permission` option was omitted, so the Session was opened at "' + FULL_PERMISSION + '" (a permission preset is chosen only when `permission` is given).';
}
function readOptions(args) {
  const preset = args?.preset?.trim() || undefined;
  const model = args?.model?.trim() || undefined;
  const requested = args?.permission?.trim() || undefined;
  const overridden = requested !== undefined && RESTRICTIVE_PERMISSIONS.includes(requested.toLowerCase()) && process.env.DSBOT_ALLOW_RESTRICTIVE_PERMISSION !== "1" ? requested : undefined;
  const permission = overridden === undefined ? requested : FULL_PERMISSION;
  return {
    ...preset === undefined ? {} : { preset },
    ...model === undefined ? {} : { model },
    ...permission === undefined ? {} : { permission },
    ...overridden === undefined ? {} : { permissionOverriddenFrom: overridden }
  };
}
async function isFolder(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function resolvePlacement(ctx, folder, workspace) {
  if (folder !== undefined) {
    if (!await isFolder(folder)) {
      throw new SessionCreateError("folder-missing", `"${folder}" is not an existing folder; no Session was made.`);
    }
    return { placement: { cwd: folder }, text: `folder ${folder}` };
  }
  const wanted = workspace;
  const registry = ctx.workspaceRegistry;
  const direct = registry.get?.(wanted);
  const found = direct ?? await registry.resolveByPath?.(wanted);
  if (!found) {
    throw new SessionCreateError("workspace-unknown", `no DSH workspace matches "${wanted}"; no Session was made.`);
  }
  const id = found.id ?? (direct === undefined ? undefined : wanted);
  if (typeof id !== "string" || id === "") {
    throw new SessionCreateError("workspace-unknown", `the DSH workspace matched "${wanted}" but gave no id; no Session was made.`);
  }
  return { placement: { workspaceId: id }, text: `workspace ${found.title ?? id}` };
}
async function archiveQuietly(ctx, sessionId) {
  try {
    await ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
function shortOf(value) {
  if (typeof value === "string")
    return value;
  if (value === undefined)
    return "undefined";
  if (value === null)
    return "null";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
async function resolvePreset(ctx, preset) {
  const presets = ctx.agentPresets;
  if (typeof presets?.list !== "function") {
    throw new SessionCreateError("host-missing", "this harness has no agentPresets.list, so `preset` could not be checked. No Session was made.");
  }
  const entries = await presets.list();
  const all = Array.isArray(entries) ? entries : [];
  const ids = all.map((entry) => entry?.id).filter((id) => typeof id === "string");
  const found = all.find((entry) => entry?.id === preset);
  if (found === undefined) {
    const available = ids.length === 0 ? "(the harness reported none)" : ids.join(", ");
    throw new SessionCreateError("preset-unknown", `no agent preset "${preset}" on this harness (available: ${available}). No Session was made.`);
  }
  if (found.broken !== undefined) {
    const available = ids.length === 0 ? "(the harness reported none)" : ids.join(", ");
    throw new SessionCreateError("preset-broken", `the agent preset "${preset}" is broken on this harness (${shortOf(found.broken)}); available: ${available}. No Session was made.`);
  }
  return preset;
}
function commandVerdict(outcome) {
  const result = outcome?.result;
  const kind = result?.kind;
  if (kind === "success")
    return { ok: true };
  if (kind === "error") {
    return { ok: false, reason: typeof result?.text === "string" && result.text !== "" ? result.text : "the host rejected the command" };
  }
  return { ok: false, reason: `unrecognized command result (kind=${shortOf(kind)}; raw=${shortOf(outcome).slice(0, 300)})` };
}
async function applyPermission(ctx, controller, sessionId, permission, signal, timeoutMs) {
  const commands = ctx.commands;
  if (typeof commands?.execute !== "function") {
    throw new SessionCreateError("host-missing", "this harness has no commands.execute, so `permission` was not applied.");
  }
  const agent = (await controller.resolveAgent?.(sessionId))?.agent;
  if (agent === undefined) {
    throw new SessionCreateError("options-failed", "the Session was made but it could not be reached to set its permission (session unavailable).");
  }
  const outcome = await commands.execute(agent, `/permission ${permission}`, [], signal ?? AbortSignal.timeout(timeoutMs ?? SESSION_OPTION_TIMEOUT_MS));
  const verdict = commandVerdict(outcome);
  if (!verdict.ok) {
    throw new SessionCreateError("options-failed", `the host refused the permission "${permission}": ${verdict.reason}`);
  }
  return agent;
}
async function applyDenyOnly(agent) {
  const session = agent?.session;
  if (typeof session?.append !== "function") {
    throw new SessionCreateError("host-missing", "this harness exposes no session.append, so an `auto` dispatch cannot be made deny-only.");
  }
  try {
    session.append("approval/policy", { policy: AUTO_APPROVAL_POLICY });
  } catch (error) {
    throw new SessionCreateError("options-failed", `the Session was made but its approval policy could not be set to "${AUTO_APPROVAL_POLICY}" (${reasonOf(error)}).`);
  }
  return AUTO_APPROVAL_POLICY;
}
async function recordFailedDispatch(ledgerPath, record) {
  try {
    await appendDispatch(ledgerPath, {
      sessionId: record.sessionId,
      title: record.title,
      placement: record.placement,
      dispatchedAt: Date.now(),
      promptHead: record.promptHead,
      ...record.preset === undefined ? {} : { preset: record.preset },
      ...record.permission === undefined ? {} : { permission: record.permission },
      ...record.permissionOverriddenFrom === undefined ? {} : { permissionOverriddenFrom: record.permissionOverriddenFrom },
      ...record.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: record.dispatcherSessionId },
      failed: record.failure
    });
    return;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
async function dispatcherModelRef(controller, dispatcherSessionId) {
  if (dispatcherSessionId === undefined)
    return;
  try {
    const resolved = await controller.resolveAgent?.(dispatcherSessionId);
    if (!resolved || "error" in resolved || !resolved.agent)
      return;
    const session = resolved.agent.session;
    const config = session?.requestHeader?.()?.config;
    if (config === undefined || typeof config.provider !== "string" || typeof config.model !== "string") {
      return;
    }
    return {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }
    };
  } catch {
    return;
  }
}
function parseModelRef(ref) {
  const cut = ref.indexOf("/");
  const provider = cut === -1 ? "" : ref.slice(0, cut).trim();
  const model = cut === -1 ? "" : ref.slice(cut + 1).trim();
  if (provider === "" || model === "") {
    throw new SessionCreateError("model-invalid", `"${ref}" is not a model written as "provider/model"; no Session was made.`);
  }
  return { provider, model };
}
async function createSessionIn(ctx, args, opts = {}) {
  const missing = preflight(ctx);
  if (missing.length > 0) {
    throw new SessionCreateError("host-missing", `this harness is missing ${missing.join(", ")}; no Session was made.`);
  }
  const { title, prompt, folder, workspace } = validate(args);
  const options = readOptions(args);
  const permissionNote = resolveDefaultPermission(ctx, options);
  const preset = options.preset === undefined ? undefined : await resolvePreset(ctx, options.preset);
  if (options.permission !== undefined && typeof ctx.commands?.execute !== "function") {
    throw new SessionCreateError("host-missing", "this harness has no commands.execute, so `permission` could not be applied. No Session was made.");
  }
  if (options.permission === AUTO_PERMISSION && ctx.approval === undefined) {
    throw new SessionCreateError("host-missing", "this harness has no approval service, so an `auto` dispatch cannot be made deny-only. No Session was made.");
  }
  const { placement, text } = await resolvePlacement(ctx, folder, workspace);
  const controller = ctx.sessionController;
  const explicit = options.model === undefined ? undefined : parseModelRef(options.model);
  const pinned = explicit === undefined ? await dispatcherModelRef(controller, opts.dispatcherSessionId) : explicit;
  if (pinned === undefined) {
    throw new SessionCreateError("dispatcher-model-unknown", `the model of the dispatching Session${opts.dispatcherSessionId === undefined ? "" : ` "${opts.dispatcherSessionId}"`} could not be read, so a new Session would have to fall back to the host's global default model. No Session was made; name a model explicitly if this dispatch must go out.`);
  }
  const created = await controller.create?.({ ...placement, ...preset === undefined ? {} : { agentPreset: preset } });
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new SessionCreateError("no-session-id", "the host returned no session id; nothing was written.");
  }
  const ledgerPath = opts.ledger ?? defaultLedgerPath();
  let renamed = true;
  try {
    const resolved = await controller.resolveAgent?.(sessionId);
    if (!resolved || "error" in resolved) {
      throw new Error(resolved?.error?.message ?? "session unavailable");
    }
    await ctx.sessionTitle?.rename?.(resolved.agent?.session, title);
  } catch {
    renamed = false;
  }
  const model = `${pinned.provider}/${pinned.model}`;
  let modelNote;
  try {
    if (controller.selectModel === undefined)
      throw new Error("the host exposes no selectModel");
    await controller.selectModel({
      sessionId,
      provider: pinned.provider,
      model: pinned.model,
      ...pinned.reasoningEffort === undefined ? {} : { reasoningEffort: pinned.reasoningEffort }
    });
  } catch (error) {
    modelNote = `the Session model was NOT pinned to ${model} (${reasonOf(error)}); it may fall back to the host default model — check its model before it spends anything.`;
  }
  let approvalPolicy;
  if (options.permission !== undefined) {
    try {
      const agent = await applyPermission(ctx, controller, sessionId, options.permission, opts.signal, opts.timeoutMs);
      if (options.permission === AUTO_PERMISSION)
        approvalPolicy = await applyDenyOnly(agent);
    } catch (error) {
      const archived = await archiveQuietly(ctx, sessionId);
      const tail = archived.ok ? `the Session ${sessionId} was archived.` : `the Session ${sessionId} may still be in the session list (archiving it failed: ${archived.reason}).`;
      const failure = error instanceof Error ? error.message : String(error);
      const ledgerNote = await recordFailedDispatch(ledgerPath, {
        sessionId,
        title,
        placement: text,
        promptHead: headOf(prompt, 200),
        failure,
        ...preset === undefined ? {} : { preset },
        ...options.permission === undefined ? {} : { permission: options.permission },
        ...options.permissionOverriddenFrom === undefined ? {} : { permissionOverriddenFrom: options.permissionOverriddenFrom },
        ...opts.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: opts.dispatcherSessionId }
      });
      const note = ledgerNote === undefined ? ` It was recorded in the dispatch ledger (${ledgerPath}) so it can be found later.` : ` The dispatch ledger could not record it either (${ledgerNote}); keep this id by hand.`;
      const code = error instanceof SessionCreateError ? error.code : "options-failed";
      throw new SessionCreateError(code, `the Session was made but its permission was not applied (${reasonOf(error)}); ${tail}${note}`);
    }
  }
  const applied = {
    ...preset === undefined ? {} : { preset },
    ...options.permission === undefined ? {} : { permission: options.permission },
    ...options.permissionOverriddenFrom === undefined ? {} : { permissionOverriddenFrom: options.permissionOverriddenFrom },
    ...approvalPolicy === undefined ? {} : { approvalPolicy },
    model
  };
  try {
    await controller.prompt?.({
      requestId: randomUUID(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }]
    }, opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? PROMPT_TIMEOUT_MS));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const archived = await archiveQuietly(ctx, sessionId);
    const tail = archived.ok ? `the Session ${sessionId} was archived.` : `the Session ${sessionId} may still be in the session list (archiving it failed: ${archived.reason}).`;
    throw new SessionCreateError("prompt-failed", `the Session was made but the prompt did not go through (${reason}); ${tail}`);
  }
  let ledgerError;
  try {
    await appendDispatch(ledgerPath, {
      sessionId,
      title,
      placement: text,
      dispatchedAt: Date.now(),
      promptHead: headOf(prompt, 200),
      ...applied.preset === undefined ? {} : { preset: applied.preset },
      ...applied.permission === undefined ? {} : { permission: applied.permission },
      ...applied.permissionOverriddenFrom === undefined ? {} : { permissionOverriddenFrom: applied.permissionOverriddenFrom },
      ...applied.approvalPolicy === undefined ? {} : { approvalPolicy: applied.approvalPolicy },
      ...opts.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: opts.dispatcherSessionId }
    });
  } catch (error) {
    ledgerError = error instanceof Error ? error.message : String(error);
  }
  return {
    sessionId,
    title,
    placement: text,
    renamed,
    ...applied,
    ledgerPath,
    ...permissionNote === undefined ? {} : { permissionNote },
    ...modelNote === undefined ? {} : { modelNote },
    ...ledgerError === undefined ? {} : { ledgerError }
  };
}
var LEDGER_FILE = "dispatched-sessions.jsonl";
function sessionCreateDir(env = process.env, home = homedir()) {
  const root = (env.DSH_HOME ?? "").trim() || join(home, ".dsh");
  return join(root, "bot", "session-create");
}
function defaultLedgerPath(env = process.env, home = homedir()) {
  const explicit = (env.DSH_SESSION_CREATE_LEDGER ?? "").trim();
  if (explicit !== "")
    return explicit;
  return join(sessionCreateDir(env, home), LEDGER_FILE);
}
function headOf(text, max) {
  if (text.length <= max)
    return text;
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max);
}
async function appendDispatch(ledgerPath, record) {
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(record)}
`, "utf8");
}
async function readLedger(ledgerPath) {
  let text;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT")
      return [];
    throw new SessionCreateError("ledger-unreadable", `the dispatch ledger ${ledgerPath} exists but could not be read (${reasonOf(error)}).`);
  }
  const bySession = new Map;
  for (const line of text.split(`
`)) {
    if (line.trim() === "")
      continue;
    try {
      const record = JSON.parse(line);
      if (typeof record?.sessionId !== "string" || record.sessionId === "")
        continue;
      bySession.set(record.sessionId, record);
    } catch {}
  }
  const records = [...bySession.values()];
  records.sort((a, b) => (Number(a.dispatchedAt) || 0) - (Number(b.dispatchedAt) || 0));
  return records;
}
async function markRead(ledgerPath, sessionId, seq, at = Date.now()) {
  const record = (await readLedger(ledgerPath)).find((item) => item.sessionId === sessionId);
  if (record === undefined)
    return false;
  await appendDispatch(ledgerPath, { ...record, lastReadSeq: seq, lastReadAt: at });
  return true;
}
async function markNotified(ledgerPath, sessionId, at = Date.now()) {
  const record = (await readLedger(ledgerPath)).find((item) => item.sessionId === sessionId);
  if (record === undefined)
    return false;
  await appendDispatch(ledgerPath, { ...record, notifiedAt: at });
  return true;
}
function blockText(content) {
  if (!Array.isArray(content))
    return "";
  return content.filter((block) => {
    const b = block;
    return b?.type === "text" && typeof b.text === "string";
  }).map((block) => block.text).join(`
`).trim();
}
function clipText(text) {
  if (text.length <= MESSAGE_CLIP)
    return text;
  return `${text.slice(0, MESSAGE_CLIP)}… (cut; ${text.length} characters in all)`;
}
function renderTranscript(events) {
  let turn;
  let headSeq = 0;
  const ended = new Set;
  const messages = [];
  for (const raw of events) {
    const event = raw;
    if (event === null || typeof event !== "object")
      continue;
    if (typeof event.seq === "number" && Number.isInteger(event.seq))
      headSeq = Math.max(headSeq, event.seq);
    if (event.type === "turn/start") {
      const n = event.data?.turn;
      if (typeof n === "number" && Number.isInteger(n))
        turn = n;
      continue;
    }
    if (event.type === "turn/end") {
      const n = event.data?.turn;
      if (typeof n === "number" && Number.isInteger(n))
        ended.add(n);
      continue;
    }
    if (event.type === "user/message") {
      const source = event.data?.source;
      if (source?.kind !== "user")
        continue;
      const text = blockText(event.data?.content);
      if (text === "")
        continue;
      messages.push({ role: "user", text: clipText(text), seq: event.seq ?? 0, time: event.time ?? 0 });
      continue;
    }
    if (event.type === "assistant/message") {
      const message = event.data?.message;
      const text = blockText(message?.content);
      if (text === "")
        continue;
      messages.push({ role: "assistant", text: clipText(text), seq: event.seq ?? 0, time: event.time ?? 0 });
    }
  }
  const status = turn === undefined ? "not-started" : ended.has(turn) ? "idle" : "running";
  return { status, turn, headSeq, messages };
}
async function readSessionIn(ctx, args = {}, opts = {}) {
  const missing = preflightRead(ctx);
  if (missing.length > 0) {
    throw new SessionCreateError("host-missing", `this harness cannot read a Session's history: it is missing ${missing.join(", ")}.`);
  }
  const ledgerPath = opts.ledger ?? defaultLedgerPath();
  const sessionId = (args.sessionId ?? "").trim();
  if (sessionId === "") {
    throw new SessionCreateError("no-session", "give a session id: sessionId is required and cannot be omitted.");
  }
  let fromLedger;
  let ledgerError;
  try {
    fromLedger = (await readLedger(ledgerPath)).find((record) => record.sessionId === sessionId);
  } catch (error) {
    ledgerError = reasonOf(error);
  }
  const controller = ctx.sessionController;
  const resolved = await controller.resolveAgent?.(sessionId);
  if (!resolved || "error" in resolved || resolved.agent?.session === undefined || resolved.agent.session === null) {
    throw new SessionCreateError("session-unknown", `no Session "${sessionId}" is known to this harness${resolved?.error?.message ? ` (${resolved.error.message})` : ""}.`);
  }
  const seq = Number(resolved.agent.session.seq);
  if (!Number.isFinite(seq)) {
    throw new SessionCreateError("session-no-seq", `the harness gave no sequence number for Session "${sessionId}"; nothing was read.`);
  }
  const last = clamp(args.last ?? MESSAGES_DEFAULT, 1, MESSAGES_MAX);
  let page;
  try {
    page = await controller.page?.({ address: { kind: "session", sessionId }, throughSeq: seq - 1, maxMessages: last }, opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? HISTORY_TIMEOUT_MS));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SessionCreateError("read-failed", `the harness would not give Session "${sessionId}" back (${reason}).`);
  }
  if (page === undefined) {
    throw new SessionCreateError("read-failed", `the harness returned nothing for Session "${sessionId}".`);
  }
  const rendered = renderTranscript((page.records ?? []).map((record) => record?.event));
  const headSeq = Math.max(seq - 1, rendered.headSeq);
  const newEvents = fromLedger?.lastReadSeq === undefined ? undefined : Math.max(0, headSeq - fromLedger.lastReadSeq);
  const hostStatus = resolved.agent?.status;
  const status = hostStatus === "running" ? "running" : hostStatus === "idle" ? "idle" : rendered.status;
  const statusFrom = hostStatus === "running" || hostStatus === "idle" ? "host" : "transcript";
  if (opts.markRead !== false && ledgerError === undefined) {
    try {
      await markRead(ledgerPath, sessionId, headSeq);
    } catch (error) {
      ledgerError = reasonOf(error);
    }
  }
  return {
    ...rendered,
    status,
    statusFrom,
    headSeq,
    sessionId,
    hasMore: page.hasMore === true,
    ...fromLedger?.title === undefined ? {} : { title: fromLedger.title },
    ...fromLedger?.placement === undefined ? {} : { placement: fromLedger.placement },
    ...fromLedger?.dispatchedAt === undefined ? {} : { dispatchedAt: fromLedger.dispatchedAt },
    ...fromLedger?.lastReadSeq === undefined ? {} : { lastReadSeq: fromLedger.lastReadSeq },
    ...newEvents === undefined ? {} : { newEvents },
    ...ledgerError === undefined ? {} : { ledgerError }
  };
}
function preflightMessage(ctx) {
  const missing = [];
  if (typeof ctx?.sessionController?.resolveAgent !== "function")
    missing.push("sessionController.resolveAgent");
  if (typeof ctx?.sessionController?.prompt !== "function")
    missing.push("sessionController.prompt");
  return missing;
}
function validateMessage(args) {
  const sessionId = (args?.sessionId ?? "").trim();
  const message = (args?.message ?? "").trim();
  if (sessionId === "")
    throw new SessionCreateError("missing-session-id", "a sessionId is required; nothing was sent.");
  if (message === "")
    throw new SessionCreateError("missing-message", "a message is required; nothing was sent.");
  return { sessionId, message };
}
async function messageSessionIn(ctx, args = {}, opts = {}) {
  const missing = preflightMessage(ctx);
  if (missing.length > 0) {
    throw new SessionCreateError("host-missing", `this harness cannot send into a Session: it is missing ${missing.join(", ")}. Nothing was sent.`);
  }
  const { sessionId, message } = validateMessage(args);
  const controller = ctx.sessionController;
  const ledgerPath = opts.ledger ?? defaultLedgerPath();
  let title;
  let placement;
  let ledgerError;
  try {
    const record = (await readLedger(ledgerPath)).find((entry) => entry.sessionId === sessionId);
    title = record?.title;
    placement = record?.placement;
  } catch (error) {
    ledgerError = reasonOf(error);
  }
  const resolved = await controller.resolveAgent?.(sessionId);
  if (!resolved || "error" in resolved || resolved.agent?.session === undefined || resolved.agent.session === null) {
    throw new SessionCreateError("session-unknown", `no Session "${sessionId}" is known to this harness${resolved?.error?.message ? ` (${resolved.error.message})` : ""}; nothing was sent.`);
  }
  const hostStatus = resolved.agent?.status;
  if (hostStatus === "idle") {
    throw new SessionCreateError("session-idle", `Session "${sessionId}" has finished its turn (the harness reports it idle), so it is not a dispatch still in flight. Taking that work further is a new task and takes a new Session — call create_session. Nothing was sent.`);
  }
  const targetState = hostStatus === "running" ? "running" : "unreported";
  let outcome;
  try {
    outcome = await controller.prompt?.({
      requestId: randomUUID(),
      sessionId,
      mode: "steer",
      content: [{ type: "text", text: message }]
    }, opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? MESSAGE_TIMEOUT_MS));
  } catch (error) {
    throw new SessionCreateError("message-failed", `the message did not go into Session "${sessionId}" (${reasonOf(error)}); nothing was delivered.`);
  }
  if (outcome === false) {
    throw new SessionCreateError("message-refused", `the harness refused the message for Session "${sessionId}"; nothing was delivered.`);
  }
  return { sessionId, targetState, ...title === undefined ? {} : { title }, ...placement === undefined ? {} : { placement }, ...ledgerError === undefined ? {} : { ledgerError } };
}
async function listDispatchedIn(ctx, args = {}, opts = {}) {
  const ledgerPath = opts.ledger ?? defaultLedgerPath();
  const limit = clamp(args.limit ?? 5, 1, 20);
  const caller = args.all === true ? undefined : dispatcherSessionOf(opts.exec);
  const records = (await readLedger(ledgerPath)).filter((record) => caller === undefined || record.dispatcherSessionId === caller).slice(-limit).reverse();
  const lines = [];
  for (const record of records) {
    try {
      const transcript = await readSessionIn(ctx, { sessionId: record.sessionId, last: 6 }, { ...opts, ledger: ledgerPath, markRead: false });
      lines.push({
        record,
        status: transcript.status,
        headSeq: transcript.headSeq,
        ...transcript.newEvents === undefined ? {} : { newEvents: transcript.newEvents }
      });
    } catch (error) {
      lines.push({ record, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ledgerPath, lines };
}
function clamp(value, min, max) {
  const n = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(Math.max(n, min), max);
}
var SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
function stamp(time) {
  if (!Number.isFinite(time) || time <= 0)
    return "?";
  const d = new Date(time + SHANGHAI_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
var QUIET_WINDOW_MS = 120000;
var COMPLETED_REASON = "completed";
var NOTIFY_TIMEOUT_MS = 1e4;
var TERMINAL_MARKS = ["[DISPATCH DONE]", "[NEEDS USER]", "[DISPATCH BLOCKED]"];
var LAST_MESSAGE_PAGE = 8;
function terminalMarkOf(text) {
  let found;
  let at = -1;
  for (const mark of TERMINAL_MARKS) {
    const index = text.lastIndexOf(mark);
    if (index > at) {
      at = index;
      found = mark;
    }
  }
  return found;
}
function deadlineSamples(records) {
  const minutes = [];
  for (const record of records) {
    const from = Number(record.dispatchedAt);
    const to = Number(record.notifiedAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
      continue;
    minutes.push((to - from) / 60000);
  }
  return minutes;
}
function suggestDeadlineSeconds(records, window = 30) {
  const sample = deadlineSamples(records).slice(-window);
  if (sample.length < 5)
    return;
  const sorted = [...sample].sort((a, b) => a - b);
  const pos = 0.95 * (sorted.length - 1);
  const lo = Math.floor(pos);
  const p95 = sorted[lo] + (pos - lo) * ((sorted[lo + 1] ?? sorted[lo]) - sorted[lo]);
  return Math.ceil(p95 * 1.2) * 60;
}
function dispatcherSessionOf(exec) {
  const id = exec?.agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}
function receiptText(record, sessionId, endTime, mark, turn, reason) {
  const title = typeof record?.title === "string" && record.title !== "" ? record.title : "(untitled)";
  const last = `turn ${turn === undefined ? "?" : turn}${reason === undefined ? "" : `, reason: ${reason}`}`;
  return `[Dispatch receipt · ${title}] ${mark} · session ${sessionId} · ended ${stamp(endTime)} (${last})`;
}
function createDispatchNotifier(deps = {}) {
  const ledgerPath = deps.ledger ?? defaultLedgerPath();
  const quietMs = deps.quietMs ?? QUIET_WINDOW_MS;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(() => {
    fn();
  }, ms));
  const clearTimer = deps.clearTimer ?? ((handle2) => clearTimeout(handle2));
  const log = deps.log ?? ((line) => console.warn(`[dsbot-session-create] ${line}`));
  const pending = new Map;
  const notified = new Set;
  async function recordOf(sessionId) {
    try {
      return (await readLedger(ledgerPath)).find((record) => record.sessionId === sessionId);
    } catch (error) {
      log(`the dispatch ledger could not be read, so no receipt was sent for ${sessionId} (${reasonOf(error)}).`);
      return;
    }
  }
  async function resolveQuietly(controller, sessionId) {
    try {
      return await controller.resolveAgent?.(sessionId);
    } catch (error) {
      log(`the harness would not resolve the Session ${sessionId} (${reasonOf(error)}).`);
      return;
    }
  }
  async function firstBusyChild(sessionId, controller) {
    let children;
    try {
      children = (await readLedger(ledgerPath)).filter((record) => record.dispatcherSessionId === sessionId && record.sessionId !== sessionId);
    } catch (error) {
      log(`the dispatch ledger could not be read while checking whether ${sessionId} is still waiting on its own dispatches (${reasonOf(error)}).`);
      return;
    }
    for (const child of children) {
      const resolved = await resolveQuietly(controller, child.sessionId);
      if (resolved?.agent === undefined)
        continue;
      if (resolved.agent.status !== "idle")
        return child.sessionId;
    }
    return;
  }
  async function lastAssistantText(controller, sessionId, seq) {
    if (typeof controller.page !== "function") {
      return { error: "this harness has no sessionController.page, so its last assistant message cannot be read" };
    }
    const at = Number(seq);
    if (!Number.isFinite(at)) {
      return { error: "the harness gave no sequence number for it, so its last assistant message cannot be read" };
    }
    let page;
    try {
      page = await controller.page({ address: { kind: "session", sessionId }, throughSeq: at - 1, maxMessages: LAST_MESSAGE_PAGE }, AbortSignal.timeout(HISTORY_TIMEOUT_MS));
    } catch (error) {
      return { error: `its last assistant message could not be read (${reasonOf(error)})` };
    }
    if (page === undefined) {
      return { error: "the harness returned nothing for it, so its last assistant message cannot be read" };
    }
    const events = (page.records ?? []).map((record) => record?.event);
    for (let index = events.length - 1;index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "assistant/message")
        continue;
      const message = event.data?.message;
      const text = blockText(message?.content);
      if (text !== "")
        return { text };
    }
    return { error: "no assistant message with text was found among its last events" };
  }
  async function deliver(sessionId, endTime, turn, reason) {
    if (notified.has(sessionId))
      return;
    const record = await recordOf(sessionId);
    if (record === undefined)
      return;
    if (typeof record.notifiedAt === "number" && record.notifiedAt >= endTime)
      return;
    const dispatcher = record.dispatcherSessionId;
    if (dispatcher === undefined || dispatcher === "") {
      log(`${sessionId} went quiet, but its ledger line has no dispatcherSessionId (it was dispatched before this feature), so no receipt was sent.`);
      return;
    }
    if (dispatcher === sessionId)
      return;
    const controller = deps.controllerOf?.();
    if (typeof controller?.resolveAgent !== "function" || typeof controller?.prompt !== "function") {
      log(`${sessionId} went quiet, but this harness has no sessionController.resolveAgent/prompt, so no receipt was sent.`);
      return;
    }
    const resolved = await resolveQuietly(controller, sessionId);
    if (resolved?.agent?.status !== "idle") {
      log(`${sessionId} went quiet, but the harness does not report it idle (status=${shortOf(resolved?.agent?.status)}), so no receipt was sent.`);
      return;
    }
    const waitingOn = await firstBusyChild(sessionId, controller);
    if (waitingOn !== undefined) {
      log(`${sessionId} went quiet, but the Session it dispatched (${waitingOn}) is not idle, so it is waiting rather than finished; no receipt was sent.`);
      return;
    }
    const lastText = await lastAssistantText(controller, sessionId, resolved?.agent?.session?.seq);
    if ("error" in lastText) {
      log(`${sessionId} went quiet, but ${lastText.error}; no receipt was sent.`);
      return;
    }
    const mark = terminalMarkOf(lastText.text);
    if (mark === undefined) {
      log(`${sessionId} went quiet, but its last message has no terminal mark; receipt withheld (expected one of ${TERMINAL_MARKS.join(" / ")}).`);
      return;
    }
    const target = await resolveQuietly(controller, dispatcher);
    if (target === undefined || target.error !== undefined || target.agent === undefined) {
      log(`${sessionId} went quiet, but the dispatching Session ${dispatcher} is gone, so there is nowhere to send the receipt.`);
      return;
    }
    try {
      await controller.prompt({
        requestId: randomUUID(),
        sessionId: dispatcher,
        mode: "queue",
        content: [{ type: "text", text: receiptText(record, sessionId, endTime, mark, turn, reason) }]
      }, AbortSignal.timeout(NOTIFY_TIMEOUT_MS));
    } catch (error) {
      log(`the receipt for ${sessionId} did not go through (${reasonOf(error)}); the next turn to end will try again.`);
      return;
    }
    notified.add(sessionId);
    try {
      await markNotified(ledgerPath, sessionId, now());
    } catch (error) {
      log(`the receipt for ${sessionId} was delivered, but the ledger could not record notifiedAt (${reasonOf(error)}).`);
    }
    log(`receipt for ${sessionId} delivered to the dispatching Session ${dispatcher}.`);
  }
  async function handle(session, event) {
    const sessionId = typeof session?.id === "string" ? session.id : undefined;
    if (sessionId === undefined || sessionId === "")
      return;
    const type = event?.type;
    if (type !== "turn/start" && type !== "turn/end")
      return;
    const record = await recordOf(sessionId);
    if (record === undefined)
      return;
    if (type === "turn/start") {
      const previous2 = pending.get(sessionId);
      if (previous2 !== undefined) {
        clearTimer(previous2.handle);
        pending.delete(sessionId);
      }
      notified.delete(sessionId);
      return;
    }
    const reason = typeof event?.data?.reason?.kind === "string" ? event.data.reason.kind : undefined;
    const turn = typeof event?.data?.turn === "number" ? event.data.turn : undefined;
    if (reason !== COMPLETED_REASON) {
      log(`${sessionId} ended turn ${turn === undefined ? "?" : turn} with reason ${shortOf(reason)}, which is not a normal finish, so no receipt is scheduled.`);
      return;
    }
    const previous = pending.get(sessionId);
    if (previous !== undefined)
      clearTimer(previous.handle);
    const endTime = now();
    const handle2 = setTimer(() => {
      pending.delete(sessionId);
      return deliver(sessionId, endTime, turn, reason);
    }, quietMs);
    pending.set(sessionId, { endTime, handle: handle2 });
  }
  return {
    async onEvent(session, event) {
      try {
        await handle(session, event);
      } catch (error) {
        log(`a session event could not be handled (${reasonOf(error)}).`);
      }
    },
    pending: () => [...pending.entries()].map(([sessionId, quiet]) => ({ sessionId, endTime: quiet.endTime }))
  };
}
function installDispatchNotify(ctx, opts = {}) {
  const on = ctx?.on;
  if (typeof on !== "function") {
    console.warn("[dsbot-session-create] this harness context has no `on`, so a Session that finishes cannot report back by itself; read_session_transcript still works.");
    return;
  }
  const notifier = createDispatchNotifier({ ...opts, controllerOf: () => resolveServices(ctx).sessionController });
  on.call(ctx, "session/event", (session, event) => {
    notifier.onEvent(session, event);
  });
  return notifier;
}

// src/autoresume.ts
var AUTORESUME_ENV_FLAG = "DSH_AUTORESUME_DISABLE";
var AUTORESUME_STATE_DIR_ENV = "DSH_AUTORESUME_STATE_DIR";
var AUTORESUME_PENDING_NAME = "restart-pending.json";
var AUTORESUME_ACK_NAME = "restart-pending.ack.json";
function resolveAutoresumeStateDir(env = process.env, home = homedir2()) {
  const explicit = (env[AUTORESUME_STATE_DIR_ENV] ?? "").trim();
  return explicit !== "" ? explicit : sessionCreateDir(env, home);
}
var AUTORESUME_STATE_DIR = resolveAutoresumeStateDir();
var AUTORESUME_PENDING_FILE = join2(AUTORESUME_STATE_DIR, AUTORESUME_PENDING_NAME);
var AUTORESUME_ACK_FILE = join2(AUTORESUME_STATE_DIR, AUTORESUME_ACK_NAME);
var AUTORESUME_RETRY_DELAYS_MS = [6000, 12000, 20000];
var AUTORESUME_DELAY_MS = AUTORESUME_RETRY_DELAYS_MS[0];
var AUTORESUME_TIMEOUT_MS = 1e4;
function reasonOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
async function writeAtomicDefault(path, text) {
  const dir = dirname2(path);
  await mkdir2(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}
function isStrictlyNewer(candidate, acked) {
  const fresh = Date.parse(candidate);
  const old = Date.parse(acked);
  if (!Number.isNaN(fresh) && !Number.isNaN(old))
    return fresh > old;
  return candidate > acked;
}
function wakeupText(pointer, pendingFile) {
  const raw = pointer?.host_pid;
  const pid = typeof raw === "number" || typeof raw === "string" ? String(raw) : "未知";
  return `[重启自检] 宿主已重启（上一个宿主 pid ${pid}）。盘上有接手指针：${pendingFile} —— 先读它再动手，不要凭记忆。`;
}
async function recordFailure(input) {
  const record = {
    result: "send-failed",
    attempts: input.attempts,
    reason: input.reason,
    attempted_at: new Date(input.now()).toISOString()
  };
  if (input.sessionId !== undefined && input.sessionId !== "")
    record.session_id = input.sessionId;
  try {
    await input.writeAtomic(input.ackFile, `${JSON.stringify(record, null, 2)}
`);
    return;
  } catch (error) {
    const ackError = reasonOf2(error);
    input.log(`startup self-check: the failure record could not be written to ${input.ackFile} (${ackError}); the next start will still try again.`);
    return ackError;
  }
}
async function readAckedWrittenAt(ackFile, readText, log) {
  let text;
  try {
    text = await readText(ackFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log(`startup self-check: ${ackFile} could not be read (${reasonOf2(error)}), so this pointer is treated as not yet confirmed.`);
    }
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    log(`startup self-check: ${ackFile} is not valid JSON (${reasonOf2(error)}), so this pointer is treated as not yet confirmed.`);
    return;
  }
  const writtenAt = parsed?.written_at;
  if (typeof writtenAt !== "string" || writtenAt === "") {
    log(`startup self-check: ${ackFile} has no written_at (a failure record, or an old format), so this pointer is treated as not yet confirmed.`);
    return;
  }
  return writtenAt;
}
async function runAutoResume(deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line) => console.warn(`[dsbot-session-create] ${line}`));
  const attempts = Number.isFinite(deps.attempt) && deps.attempt >= 1 ? Math.trunc(deps.attempt) : 1;
  if (env[AUTORESUME_ENV_FLAG] === "1") {
    const reason = `${AUTORESUME_ENV_FLAG}=1`;
    log(`startup self-check skipped (${reason}); no pointer was read.`);
    return { status: "disabled", reason };
  }
  const stateDir = resolveAutoresumeStateDir(env);
  const pendingFile = deps.pendingFile ?? join2(stateDir, AUTORESUME_PENDING_NAME);
  const ackFile = deps.ackFile ?? join2(stateDir, AUTORESUME_ACK_NAME);
  const readText = deps.readText ?? ((path) => readFile2(path, "utf8"));
  const writeAtomic = deps.writeAtomic ?? writeAtomicDefault;
  const now = deps.now ?? (() => Date.now());
  let pointer;
  try {
    const text2 = await readText(pendingFile);
    const parsed = JSON.parse(text2);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const reason = `${pendingFile} is not a JSON object`;
      log(`startup self-check: ${reason}; nothing was sent.`);
      return { status: "no-pointer", reason };
    }
    pointer = parsed;
  } catch (error) {
    const reason = reasonOf2(error);
    log(`startup self-check: no usable pointer at ${pendingFile} (${reason}); nothing was sent.`);
    return { status: "no-pointer", reason };
  }
  const writtenAt = pointer.written_at;
  if (typeof writtenAt !== "string" || writtenAt === "") {
    const reason = `${pendingFile} has no written_at`;
    log(`startup self-check: ${reason}, so it cannot be compared with the ack; nothing was sent.`);
    return { status: "written-at-missing", reason };
  }
  const acked = await readAckedWrittenAt(ackFile, readText, log);
  if (acked !== undefined && !isStrictlyNewer(writtenAt, acked)) {
    log(`startup self-check: the pointer written at ${writtenAt} was already confirmed (ack ${acked}); nothing was sent.`);
    return { status: "already-acked", writtenAt };
  }
  const notify = pointer.notify_session_id;
  const sessionId = typeof notify === "string" ? notify.trim() : "";
  if (sessionId === "") {
    const reason = `${pendingFile} has no usable notify_session_id (found ${typeof notify})`;
    log(`startup self-check: ${reason}; nothing was sent.`);
    return { status: "no-target", reason };
  }
  const fail = async (reason) => {
    log(`startup self-check: attempt ${attempts} did not wake Session "${sessionId}" (${reason}); the pointer stays unconfirmed.`);
    const ackError2 = await recordFailure({ ackFile, writeAtomic, log, reason, attempts, sessionId, now });
    return { status: "send-failed", writtenAt, sessionId, reason, attempts, ...ackError2 === undefined ? {} : { ackError: ackError2 } };
  };
  const controller = deps.controllerOf?.();
  const text = wakeupText(pointer, pendingFile);
  if (typeof controller?.prompt !== "function") {
    return await fail("this harness has no sessionController.prompt");
  }
  try {
    const outcome = await controller.prompt({
      requestId: randomUUID2(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }]
    }, deps.signal ?? AbortSignal.timeout(AUTORESUME_TIMEOUT_MS));
    if (outcome === false) {
      return await fail(`the harness refused the message for Session "${sessionId}"`);
    }
  } catch (error) {
    return await fail(reasonOf2(error));
  }
  const deliveredAt = now();
  const ack = {
    written_at: writtenAt,
    host_pid: typeof pointer.host_pid === "number" || typeof pointer.host_pid === "string" ? pointer.host_pid : null,
    host_start: pointer.host_start ?? null,
    session_id: sessionId,
    result: "delivered",
    attempts,
    delivered_at: new Date(deliveredAt).toISOString(),
    pending_file: pendingFile,
    message: text
  };
  let ackError;
  try {
    await writeAtomic(ackFile, `${JSON.stringify(ack, null, 2)}
`);
  } catch (error) {
    ackError = reasonOf2(error);
    log(`startup self-check: delivered to ${sessionId}, but the ack could not be written to ${ackFile} (${ackError}); the next start will deliver once more.`);
  }
  log(`startup self-check: the pointer written at ${writtenAt} woke Session ${sessionId} (attempt ${attempts}).`);
  return { status: "delivered", writtenAt, sessionId, attempts, ...ackError === undefined ? {} : { ackError } };
}
function defaultSchedule(fn, ms) {
  const handle = setTimeout(() => {
    fn();
  }, ms);
  handle.unref?.();
  return handle;
}
function installAutoResume(ctx, opts = {}) {
  const log = opts.log ?? ((line) => console.warn(`[dsbot-session-create] ${line}`));
  const env = opts.env ?? process.env;
  if (env[AUTORESUME_ENV_FLAG] === "1") {
    log(`startup self-check is off (${AUTORESUME_ENV_FLAG}=1); no pointer will be read.`);
    return;
  }
  const schedule = opts.schedule ?? defaultSchedule;
  const configured = opts.retryDelaysMs ?? AUTORESUME_RETRY_DELAYS_MS;
  const delays = configured.filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (delays.length === 0)
    delays.push(AUTORESUME_DELAY_MS);
  if (opts.delayMs !== undefined)
    delays[0] = opts.delayMs;
  const baseDeps = {
    pendingFile: opts.pendingFile,
    ackFile: opts.ackFile,
    env,
    log,
    readText: opts.readText,
    writeAtomic: opts.writeAtomic,
    signal: opts.signal,
    now: opts.now,
    controllerOf: opts.controllerOf ?? (() => resolveServices(ctx).sessionController)
  };
  const attempt = (index) => {
    if (index >= delays.length) {
      log(`startup self-check gave up after ${delays.length} attempt(s); the pointer stays unconfirmed, so the next host start will try again.`);
      return;
    }
    try {
      schedule(() => {
        return runAutoResume({ ...baseDeps, attempt: index + 1 }).then((outcome) => {
          if (outcome.status === "send-failed")
            attempt(index + 1);
          return outcome;
        }).catch((error) => {
          log(`startup self-check crashed (${reasonOf2(error)}); the host is unaffected.`);
          attempt(index + 1);
        });
      }, delays[index]);
    } catch (error) {
      log(`startup self-check could not be scheduled (${reasonOf2(error)}); nothing will be sent.`);
    }
  };
  attempt(0);
}

// src/index.ts
var name = "session-create";
var inject = ["tools"];
var output = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value) }]
};
var CREATE_DESCRIPTION = [
  "Start a new Session in a DSH workspace or an existing working folder you name, and deliver one prompt into it.",
  "Give exactly one of `workspace` (a workspace id, or its exact folder path) or `folder` (any existing folder).",
  "A `folder` Session joins no DSH workspace, so the user's project list stays as it is; a `workspace` Session shows up under that workspace.",
  "Optionally set the Session's agent preset (`preset`) and permission mode (`permission`) before it starts; an omitted `permission` opens the Session at `danger-full-access`.",
  "The Session's model is pinned explicitly and is never the host's global default: it is the model the dispatching Bot's own Session runs on, unless `model` names another one as `provider/model`. If neither can be read, no Session is started.",
  "The session id is written to a dispatch ledger, so its result can be collected later with read_session_transcript.",
  "Use it to open a work line in a project without creating a Bot. The Session belongs to the user, not to any Bot.",
  'When it finishes, that Session must write exactly one terminal mark in its final reply: [DISPATCH DONE] (the whole task is done), [NEEDS USER] (the user must decide something), or [DISPATCH BLOCKED] (stuck and stopped, with the state written down). A receipt is sent back to you only when that mark is present; without one nothing is sent, so a reply with no mark reads as "this round is over, still waiting on work I dispatched".',
  "After dispatching, arm one one-shot deadline for it with schedule_create(after_seconds=…) using the value this tool returns, and delete it with schedule_delete once its terminal receipt arrives (one-shot only; never a periodic check)."
].join(" ") + `
` + [
  "派会话前先自问三句：",
  "① 要落盘还是回传？落盘就在 prompt 里写死输出路径，只回摘要+路径。",
  "② 只有 Main Bot 能派吗？（值不值得做／范围多大／谁收口提交——三条不全就别派，交清单给 Main Bot）",
  "③ 派出去就管到底：prompt 写清终点（改完→测过→本地 commit），不许写「先别提交」。"
].join(`
`);
var MESSAGE_DESCRIPTION = [
  "Send one more message into a Session that already exists, by its session id. No new Session is created.",
  "This is how a dispatch that is already running gets corrected or added to, when handing it a file is not enough.",
  "Only a Session that is still working accepts it: when the harness reports the Session idle (its turn has finished), the message is refused and nothing is sent — a dispatch that has stopped is a new task, so send it a new Session with create_session.",
  "The message steers the turn that is running: the host splices it into that turn at once, so the Session reads it on its next step instead of waiting for the turn to end.",
  "Nothing yet proves the Session read it — read_session_transcript shows that.",
  "A session id this harness does not know is refused and nothing is sent; the call reports what it actually did.",
  "Read what the Session did with it afterwards using read_session_transcript."
].join(" ");
var READ_DESCRIPTION = [
  "Read back what a Session has said and where it stands, by session id: its latest messages (oldest first) and whether its current turn has already ended.",
  "This is how a dispatched Session's result is collected without opening it by hand: pass the id from create_session or from the dispatch ledger.",
  "`last` sets how many messages to bring back (1..200, default 40); older ones remain readable with a bigger value."
].join(" ");
var LIST_DESCRIPTION = [
  "List the Sessions this plugin dispatched, newest first, with each one's state right now: still working, its last turn finished, or a read error.",
  "By default only the dispatches made by the calling Session are listed; pass `all: true` to see every dispatch in the ledger.",
  "Use it to see which dispatches are ready to collect; read_session_transcript then gives the content."
].join(" ");
function statusLine(transcript) {
  const how = transcript.statusFrom === "host" ? "the harness reports this Session as" : "";
  if (transcript.statusFrom === "host") {
    return transcript.status === "running" ? `still working (${how} running)` : `finished (${how} idle)`;
  }
  if (transcript.status === "running")
    return `still working (turn ${transcript.turn} has not ended, read from the Session's own events)`;
  if (transcript.status === "idle")
    return `finished (turn ${transcript.turn} ended, read from the Session's own events)`;
  return "the prompt has not started a turn yet";
}
function formatTranscript(transcript) {
  const head = [
    `Session ${transcript.sessionId}${transcript.title === undefined ? "" : ` · "${transcript.title}"`} — ${statusLine(transcript)}`,
    transcript.placement === undefined ? "" : `place: ${transcript.placement}${transcript.dispatchedAt === undefined ? "" : ` · dispatched ${stamp(transcript.dispatchedAt)}`}`,
    `head seq ${transcript.headSeq}${transcript.newEvents === undefined ? "" : ` (${transcript.newEvents} new event(s) since the last read)`}`
  ].filter((line) => line !== "");
  const body = transcript.messages.map((message) => `[${message.role} · ${stamp(message.time)}] ${message.text}`);
  const tail = [];
  if (body.length === 0)
    tail.push("(no user or assistant message in the range that was read)");
  if (transcript.hasMore)
    tail.push("(older events exist; call again with a bigger `last` to see more)");
  if (transcript.ledgerError !== undefined)
    tail.push(`(the dispatch ledger could not be used: ${transcript.ledgerError})`);
  return [...head, ...body.length === 0 ? [] : body, ...tail].join(`
`);
}
function formatMessage(result) {
  const head = `Steered a message into Session ${result.sessionId}${result.title === undefined ? "" : ` · "${result.title}"`}.`;
  const place = result.placement === undefined ? "" : `place: ${result.placement}`;
  const state = result.targetState === "running" ? "The harness reports this Session as still running, so this goes into the turn that is in flight." : "The harness did not report this Session's state; it was taken as still in flight. If its turn had already ended, this should have gone to a new Session instead.";
  const ledger = result.ledgerError === undefined ? "" : `(the dispatch ledger could not be read, so this Session was not matched to a dispatch: ${result.ledgerError})`;
  return [
    head,
    ...place === "" ? [] : [place],
    state,
    'The host spliced it into the turn that is running (mode "steer"): the Session reads it on its next step, without waiting for that turn to finish. Nothing yet proves the Session has read it — read_session_transcript shows that.',
    ...ledger === "" ? [] : [ledger]
  ].join(`
`);
}
function apply(ctx) {
  const services = resolveServices(ctx);
  const seen = preflight(services);
  const seenRead = preflightRead(services);
  const seenMessage = preflightMessage(services);
  const seenOptions = preflightOptions(services);
  console.log(seen.length === 0 ? "[dsbot-session-create] loaded; the host services create_session needs were all present at load." : `[dsbot-session-create] loaded; at load MISSING: ${seen.join(", ")} (the tool re-checks on every call)`);
  console.log(seenRead.length === 0 ? "[dsbot-session-create] loaded; the host services the read-back tools need were all present at load." : `[dsbot-session-create] loaded; at load MISSING for read-back: ${seenRead.join(", ")} (the tools re-check on every call)`);
  console.log(seenMessage.length === 0 ? "[dsbot-session-create] loaded; the host services session_message needs were all present at load." : `[dsbot-session-create] loaded; at load MISSING for session_message: ${seenMessage.join(", ")} (the tool re-checks on every call)`);
  console.log(seenOptions.length === 0 ? "[dsbot-session-create] loaded; the host services the session options need were all present at load." : `[dsbot-session-create] loaded; at load MISSING for session options: ${seenOptions.join(", ")} (create_session re-checks on every call)`);
  const register = services.tools?.register?.bind(services.tools);
  register?.(defineTool({
    name: "create_session",
    description: CREATE_DESCRIPTION,
    parameters: {
      title: { type: "string", required: true, description: "Name of the new Session, as it shows in the user's session list." },
      prompt: { type: "string", required: true, description: "The message delivered into the new Session." },
      workspace: { type: "string", description: "A DSH workspace: its id, or its exact folder path. Give this or `folder`, not both." },
      folder: { type: "string", description: "Full path of a folder that exists. The Session works there and joins no DSH workspace. Give this or `workspace`, not both." },
      preset: { type: "string", description: "Agent preset for the new Session, fixed when it is created: `standard`, `minimal`, `ptc` (tools run as code), or `creator`. A name the host does not know is refused and the refusal lists the ones it has. Omit for the host default." },
      permission: { type: "string", description: "Permission mode for the new Session, set with the host's own `/permission` command before the prompt: `read-only`, `workspace-write`, `danger-full-access`, or `auto`. Any other name is refused by the host, which lists the valid ones. Omit it and the Session is opened at `danger-full-access` — a preset is chosen only when this is given. `read-only` and `workspace-write` are currently overridden to `danger-full-access`, so a dispatched Session cannot stall on an approval; set DSBOT_ALLOW_RESTRICTIVE_PERMISSION=1 in the host environment to keep a restrictive one. `auto` additionally pins the Session's approval policy to `never`: the host's auto reviewer still reviews every tool call, but when it denies one the action is refused outright instead of opening an approval prompt nobody is there to answer. If this harness lists no `auto` preset at all (auto review off or not installed), an explicit `auto` fails and starts nothing." },
      model: { type: "string", description: "Model for the new Session, written `provider/model`. Omit it and the Session is pinned to the model the dispatching Bot's own Session runs on — never the host's global default. A string without one slash, or with an empty side, is refused and no Session is made." }
    },
    output,
    async execute(args, exec) {
      try {
        const result = await createSessionIn(resolveServices(ctx), args, { dispatcherSessionId: dispatcherSessionOf(exec) });
        const renameNote = result.renamed ? "" : " (the host would not rename it, so it keeps its default title)";
        const ledgerNote = result.ledgerError === undefined ? `Recorded in the dispatch ledger (${result.ledgerPath}); read_session_transcript collects its result later.` : `WARNING: the Session is running, but recording it in the dispatch ledger failed (${result.ledgerError}) — keep this session id by hand.`;
        const options = [
          result.preset === undefined ? "" : `preset ${result.preset}`,
          result.permission === undefined ? "" : `permission ${result.permission}`,
          result.model === undefined ? "" : `model ${result.model}`
        ].filter((part) => part !== "");
        const overrideNote = result.permissionOverriddenFrom === undefined ? "" : `NOTE: permission "${result.permissionOverriddenFrom}" was overridden to "${result.permission}"; restrictive permissions are switched off in this plugin so a dispatched Session cannot stall on an approval. Set DSBOT_ALLOW_RESTRICTIVE_PERMISSION=1 in the host environment to keep a restrictive one.`;
        const permissionNote = result.permissionNote === undefined ? "" : `NOTE: ${result.permissionNote}`;
        const modelNote = result.modelNote === undefined ? "" : `NOTE: ${result.modelNote}`;
        let deadlineNote;
        if (result.ledgerError === undefined && result.ledgerPath !== undefined) {
          try {
            const records = await readLedger(result.ledgerPath);
            const seconds = suggestDeadlineSeconds(records);
            if (seconds === undefined) {
              deadlineNote = `- No one-shot deadline suggested: only ${deadlineSamples(records).length} completed ledger records carry both timestamps (need 5).`;
            } else {
              const minutes = seconds / 60;
              deadlineNote = `- Suggested one-shot deadline: ${minutes} minutes — if this Session has the schedule tool (standard/ptc presets mount it; minimal does not), call schedule_create(after_seconds=${minutes * 60}) for this dispatch and schedule_delete once its terminal receipt arrives.`;
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[dsbot-session-create] the dispatch ledger could not be read right after dispatching, so no one-shot deadline was suggested (${reason}).`);
          }
        }
        return [
          `Started a new Session in ${result.placement}.`,
          `- title: ${result.title}${renameNote}`,
          `- session id: ${result.sessionId}`,
          ...options.length === 0 ? [] : [`- options: ${options.join(" · ")} (permission is what was requested; the Session itself is the record)`],
          ...overrideNote === "" ? [] : [overrideNote],
          ...permissionNote === "" ? [] : [permissionNote],
          ...modelNote === "" ? [] : [modelNote],
          "The prompt is queued in the Session.",
          ledgerNote,
          ...deadlineNote === undefined ? [] : [deadlineNote]
        ].join(`
`);
      } catch (error) {
        if (error instanceof SessionCreateError)
          return `Could not start the Session: ${error.message}`;
        const reason = error instanceof Error ? error.message : String(error);
        return `Could not start the Session: ${reason}`;
      }
    }
  }));
  register?.(defineTool({
    name: "read_session_transcript",
    description: READ_DESCRIPTION,
    parameters: {
      sessionId: { type: "string", required: true, description: "The Session to read: the id create_session returned, or one listed by list_dispatched_sessions. It cannot be omitted — a dispatch can never be guessed." },
      last: { type: "number", description: "How many of the newest messages to bring back (1..200; default 40)." }
    },
    output,
    async execute(args) {
      try {
        return formatTranscript(await readSessionIn(resolveServices(ctx), args));
      } catch (error) {
        if (error instanceof SessionCreateError)
          return `Could not read the Session: ${error.message}`;
        const reason = error instanceof Error ? error.message : String(error);
        return `Could not read the Session: ${reason}`;
      }
    }
  }));
  register?.(defineTool({
    name: "list_dispatched_sessions",
    description: LIST_DESCRIPTION,
    parameters: {
      limit: { type: "number", description: "How many of the newest dispatches to show (1..20; default 5)." },
      all: { type: "boolean", description: "List every dispatch in the ledger instead of only the ones made by the calling Session (default false; for auditing)." }
    },
    output,
    async execute(args, exec) {
      const live = resolveServices(ctx);
      const missing = preflightRead(live);
      let ledger;
      try {
        ledger = await listDispatchedIn(live, args, { exec });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return `Could not read the dispatch ledger: ${reason}`;
      }
      if (ledger.lines.length === 0) {
        const caller = args.all === true ? undefined : dispatcherSessionOf(exec);
        return caller === undefined ? `No Session has been dispatched from this plugin yet (ledger: ${ledger.ledgerPath}).` : `No Session has been dispatched by this Session yet (ledger: ${ledger.ledgerPath}; pass all: true to see every dispatch).`;
      }
      const header = missing.length === 0 ? `Dispatched Sessions, newest first (ledger: ${ledger.ledgerPath})` : `Dispatched Sessions, newest first (ledger: ${ledger.ledgerPath}; this harness cannot read them back — missing ${missing.join(", ")})`;
      const lines = ledger.lines.map((line, index) => {
        const head = `${index + 1}. ${line.record.sessionId} · "${line.record.title}" · ${line.record.placement}`;
        const when = `dispatched ${stamp(line.record.dispatchedAt)}`;
        if (line.error !== undefined)
          return `${head}
   - unreadable: ${line.error} (${when})`;
        const state = line.status === "running" ? "still working" : line.status === "idle" ? "its last turn finished" : "not started";
        const fresh = line.newEvents === undefined ? "" : ` · ${line.newEvents} new event(s) since the last read`;
        return `${head}
   - ${state} · head seq ${line.headSeq}${fresh} · ${when}`;
      });
      return [header, ...lines].join(`
`);
    }
  }));
  register?.(defineTool({
    name: "session_message",
    description: MESSAGE_DESCRIPTION,
    parameters: {
      sessionId: { type: "string", required: true, description: "The Session to send into: an id this harness already knows. No new Session is made; an unknown id is refused." },
      message: { type: "string", required: true, description: "The message to deliver into that Session. It steers the turn that is running: it is spliced in at once and read on the next step, not after the turn ends." }
    },
    output,
    async execute(args) {
      try {
        return formatMessage(await messageSessionIn(resolveServices(ctx), args));
      } catch (error) {
        if (error instanceof SessionCreateError)
          return `Could not send into the Session: ${error.message}`;
        const reason = error instanceof Error ? error.message : String(error);
        return `Could not send into the Session: ${reason}`;
      }
    }
  }));
  installDispatchNotify(ctx);
  installAutoResume(ctx);
}
export {
  name,
  inject,
  apply
};
