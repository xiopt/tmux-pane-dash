// @bun
// opencode-plugin/src/normalize.ts
function object(value) {
  return value !== null && typeof value === "object" ? value : {};
}
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function sessionID(properties) {
  return str(properties.sessionID);
}
function requestID(properties, preference) {
  const ids = preference === "asked" ? [properties.id, properties.permissionID, properties.questionID, properties.requestID] : [properties.requestID, properties.id, properties.permissionID, properties.questionID];
  return ids.map(str).find((id) => id !== undefined);
}
function sessionMeta(properties) {
  const info = object(properties.info);
  const id = str(info.id) ?? sessionID(properties);
  return id ? [{ type: "session.meta", sessionID: id, parentID: str(info.parentID), title: str(info.title) }] : [];
}
function normalize(raw) {
  const properties = object(raw.properties);
  switch (raw.type) {
    case "session.status": {
      const id = sessionID(properties);
      const status = str(object(properties.status).type) ?? str(properties.status);
      return id && (status === "busy" || status === "retry" || status === "idle") ? [{ type: "status", sessionID: id, status }] : [];
    }
    case "session.idle": {
      const id = sessionID(properties);
      return id ? [{ type: "status", sessionID: id, status: "idle" }] : [];
    }
    case "permission.asked":
    case "question.asked": {
      const id = sessionID(properties);
      const request = requestID(properties, "asked");
      return id && request ? [{ type: "request.open", sessionID: id, requestID: request }] : [];
    }
    case "permission.replied":
    case "question.replied":
    case "question.rejected": {
      const id = sessionID(properties);
      const request = requestID(properties, "replied");
      return id && request ? [{ type: "request.close", sessionID: id, requestID: request }] : [];
    }
    case "session.error":
      return [{ type: "error", sessionID: sessionID(properties) }];
    case "session.created":
    case "session.updated":
      return sessionMeta(properties);
    case "session.deleted": {
      const id = str(object(properties.info).id) ?? sessionID(properties);
      return id ? [{ type: "session.deleted", sessionID: id }] : [];
    }
    case "message.updated": {
      const info = object(properties.info);
      const id = sessionID(info);
      if (info.role === "user" && id)
        return [{ type: "user-message", sessionID: id }];
      if (info.role !== "assistant")
        return [];
      const model = str(info.modelID) ?? str(object(info.model).modelID);
      return model ? [{ type: "model", model }] : [];
    }
    default:
      return [];
  }
}

// opencode-plugin/src/mode.ts
function isServeInvocation(argv) {
  return argv[1] === "serve";
}

// opencode-plugin/src/sanitize.ts
function sanitize(value) {
  return value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120);
}

// opencode-plugin/src/notifications.ts
var NOTIFY_BINARY_OPTION = "@pane_dash_notify_binary";
var MAX_EVENT_ID_BYTES = 128;
var SPAWN_OPTIONS = { stdout: "ignore", stderr: "ignore" };
function object2(value) {
  return value !== null && typeof value === "object" ? value : {};
}
function text(value) {
  if (typeof value !== "string")
    return;
  const result = sanitize(value).trim();
  return result || undefined;
}
function properties(raw) {
  return object2(raw.properties);
}
function validEventID(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_EVENT_ID_BYTES && /^[\x20-\x7e]+$/.test(value);
}
function eventID(raw) {
  return validEventID(raw.id) ? raw.id : undefined;
}
function message(prefix, value) {
  return sanitize(`${prefix}: ${value}`);
}
function questionDetail(raw) {
  const questions = properties(raw).questions;
  const first = Array.isArray(questions) ? questions[0] : undefined;
  const question = object2(first);
  return text(question.header) ?? text(question.question) ?? "question";
}
function sessionLabel(raw, context) {
  return text(context.after.title) ?? text(context.activeSessionID) ?? text(properties(raw).sessionID) ?? "session";
}
function isIdleTransition(raw, context) {
  if (context.before.status !== "working" || context.after.status !== "idle")
    return false;
  if (raw.type !== "session.idle" && raw.type !== "session.status")
    return false;
  return context.normalized.some((event) => event.type === "status" && event.status === "idle");
}
function decideNotification(raw, context) {
  const id = eventID(raw);
  if (!id)
    return;
  switch (raw.type) {
    case "permission.asked":
      return {
        eventId: id,
        kind: "permission",
        message: message("OpenCode permission", text(properties(raw).permission) ?? "request")
      };
    case "question.asked":
      return {
        eventId: id,
        kind: "question",
        message: message("OpenCode question", questionDetail(raw))
      };
    case "session.error":
      if (!context.normalized.some((event) => event.type === "error"))
        return;
      return {
        eventId: id,
        kind: "error",
        message: message("OpenCode error", sessionLabel(raw, context))
      };
    case "session.idle":
    case "session.status":
      return isIdleTransition(raw, context) ? {
        eventId: id,
        kind: "finished",
        message: message("OpenCode finished", sessionLabel(raw, context))
      } : undefined;
    default:
      return;
  }
}
function binaryOutput(stdout) {
  let value;
  try {
    value = typeof stdout === "string" ? stdout : new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return;
  }
  if (value.endsWith(`\r
`))
    value = value.slice(0, -2);
  else if (value.endsWith(`
`))
    value = value.slice(0, -1);
  if (!value.startsWith("/") || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value))
    return;
  return value;
}
var defaultSync = (command, options) => Bun.spawnSync(command, options);
function resolveNotificationBinary(sync = defaultSync) {
  try {
    const result = sync(["tmux", "show-options", "-gqv", NOTIFY_BINARY_OPTION], {
      stdout: "pipe",
      stderr: "ignore"
    });
    return result.exitCode === 0 ? binaryOutput(result.stdout) : undefined;
  } catch {
    return;
  }
}
function notificationArgv(binary, notification) {
  return [
    binary,
    "notify",
    "publish",
    "--event-id",
    notification.eventId,
    "--kind",
    notification.kind,
    "--message",
    notification.message
  ];
}
var defaultSpawn = (command, options) => Bun.spawn(command, options);
function createNotificationPublisher(binary, spawn = defaultSpawn) {
  return (notification) => {
    if (!binary || !notification)
      return;
    try {
      const child = spawn(notificationArgv(binary, notification), SPAWN_OPTIONS);
      child.exited.catch(() => {});
    } catch {}
  };
}

// opencode-plugin/src/state.ts
function createStore() {
  return { sessions: new Map };
}
function session(store, id) {
  let s = store.sessions.get(id);
  if (!s) {
    s = { runtime: "unknown", pending: new Set, errorLatched: false };
    store.sessions.set(id, s);
  }
  return s;
}
function topLevelSessionID(store, sessionID2) {
  let id = sessionID2;
  const visited = new Set;
  while (true) {
    if (visited.has(id))
      return id;
    visited.add(id);
    const parentID = store.sessions.get(id)?.parentID;
    if (!parentID)
      return id;
    id = parentID;
  }
}
function clearErrorLatchesForRoot(store, sessionID2) {
  const rootID = topLevelSessionID(store, sessionID2);
  const descendants = new Set([rootID]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, s] of store.sessions) {
      if (!descendants.has(id) && s.parentID && descendants.has(s.parentID)) {
        descendants.add(id);
        grew = true;
      }
    }
  }
  for (const id of descendants)
    session(store, id).errorLatched = false;
}
function apply(store, ev) {
  switch (ev.type) {
    case "status": {
      const s = session(store, ev.sessionID);
      s.runtime = ev.status;
      if (ev.status === "busy")
        clearErrorLatchesForRoot(store, ev.sessionID);
      break;
    }
    case "request.open":
      session(store, ev.sessionID).pending.add(ev.requestID);
      break;
    case "request.close":
      session(store, ev.sessionID).pending.delete(ev.requestID);
      break;
    case "error": {
      const id = ev.sessionID ?? store.activeSessionID;
      if (id)
        session(store, id).errorLatched = true;
      break;
    }
    case "user-message":
      clearErrorLatchesForRoot(store, ev.sessionID);
      store.activeSessionID = topLevelSessionID(store, ev.sessionID);
      break;
    case "session.meta": {
      const s = session(store, ev.sessionID);
      if (ev.parentID !== undefined) {
        s.parentID = ev.parentID;
        if (store.activeSessionID === ev.sessionID) {
          store.activeSessionID = topLevelSessionID(store, ev.sessionID);
        }
      }
      if (ev.title !== undefined)
        s.title = ev.title;
      break;
    }
    case "session.deleted":
      store.sessions.delete(ev.sessionID);
      if (store.activeSessionID === ev.sessionID)
        store.activeSessionID = undefined;
      break;
    case "active":
      store.activeSessionID = ev.sessionID;
      break;
    case "model":
      store.model = ev.model;
      break;
  }
}
function relevant(store) {
  const all = [...store.sessions.entries()];
  const active = store.activeSessionID;
  if (!active)
    return all.map(([, s]) => s);
  const included = new Set([active]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, s] of all) {
      if (!included.has(id) && s.parentID && included.has(s.parentID)) {
        included.add(id);
        grew = true;
      }
    }
  }
  return all.filter(([id]) => included.has(id)).map(([, s]) => s);
}
function derive(store) {
  const sessions = relevant(store);
  const title = store.activeSessionID ? store.sessions.get(store.activeSessionID)?.title : undefined;
  let status = "unknown";
  if (sessions.some((s) => s.pending.size > 0))
    status = "needs_input";
  else if (sessions.some((s) => s.errorLatched))
    status = "error";
  else if (sessions.some((s) => s.runtime === "busy" || s.runtime === "retry"))
    status = "working";
  else if (sessions.some((s) => s.runtime === "idle"))
    status = "idle";
  return { status, title, model: store.model };
}

// opencode-plugin/src/writer.ts
var SPAWN_OPTIONS2 = { stdout: "ignore", stderr: "ignore" };
var defaultSpawn2 = (command, options) => Bun.spawn(command, options);

class TmuxWriter {
  pane;
  spawn;
  pending = Promise.resolve();
  draining = false;
  generation = 0;
  completedGeneration = 0;
  desired = new Map;
  confirmed = new Map;
  constructor(pane, spawn = defaultSpawn2) {
    this.pane = pane;
    this.spawn = spawn;
  }
  publish(options) {
    for (const [name, value] of Object.entries(options))
      this.setOption(name, value);
  }
  clearSync() {
    for (const name of this.desired.keys()) {
      try {
        Bun.spawnSync(["tmux", "set-option", "-pu", "-t", this.pane, name]);
      } catch {}
    }
  }
  get(name) {
    return this.desired.get(name);
  }
  setOption(name, value, force = false) {
    const sanitized = sanitize(value);
    this.desired.set(name, sanitized);
    if (force)
      this.confirmed.delete(name);
    this.kick();
  }
  unsetOption(name, force = false) {
    this.desired.set(name, undefined);
    if (force)
      this.confirmed.delete(name);
    this.kick();
  }
  flush() {
    return this.pending;
  }
  kick() {
    this.generation += 1;
    if (this.draining)
      return;
    this.draining = true;
    this.pending = Promise.resolve().then(() => this.drain());
  }
  async drain() {
    while (this.completedGeneration < this.generation) {
      const generation = this.generation;
      const changes = [...this.desired].filter(([name, value]) => !this.matches(name, value));
      if (changes.length > 0)
        await this.write(changes);
      this.completedGeneration = generation;
    }
    this.draining = false;
  }
  matches(name, value) {
    return this.confirmed.has(name) && this.confirmed.get(name) === value;
  }
  async write(changes) {
    const command = ["tmux"];
    for (const [index, [name, value]] of changes.entries()) {
      if (index > 0)
        command.push(";");
      if (value === undefined)
        command.push("set-option", "-pu", "-t", this.pane, name);
      else
        command.push("set-option", "-pt", this.pane, name, value);
    }
    try {
      if (await this.spawn(command, SPAWN_OPTIONS2).exited === 0) {
        for (const [name, value] of changes)
          this.confirmed.set(name, value);
      }
    } catch {}
  }
}

// opencode-plugin/pane-dash.ts
var HEARTBEAT_MS = 20000;
var HIDDEN_STATUS = "hidden";
var STARTUP_OPTIONS = [
  "@pane_dash_status",
  "@pane_dash_status_since",
  "@pane_dash_title",
  "@pane_dash_model"
];
var PaneDash = async () => {
  const pane = process.env.TMUX_PANE;
  if (!pane)
    return {};
  const writer = new TmuxWriter(pane);
  if (isServeInvocation(process.argv)) {
    for (const name of STARTUP_OPTIONS)
      writer.unsetOption(name, true);
    writer.unsetOption("@pane_dash_heartbeat", true);
    writer.setOption("@pane_dash_status", HIDDEN_STATUS, true);
    process.on("exit", () => writer.clearSync());
    return {};
  }
  const store = createStore();
  const notify = createNotificationPublisher(resolveNotificationBinary());
  const publish = () => {
    const derived = derive(store);
    const previousStatus = writer.get("@pane_dash_status");
    writer.setOption("@pane_dash_status", derived.status);
    if (previousStatus !== derived.status) {
      writer.setOption("@pane_dash_status_since", String(Math.floor(Date.now() / 1000)));
    }
    if (derived.title === undefined)
      writer.unsetOption("@pane_dash_title");
    else
      writer.setOption("@pane_dash_title", derived.title);
    if (derived.model === undefined)
      writer.unsetOption("@pane_dash_model");
    else
      writer.setOption("@pane_dash_model", derived.model);
  };
  const heartbeat = () => {
    const value = String(Math.floor(Date.now() / 1000));
    writer.setOption("@pane_dash_heartbeat", value, true);
  };
  for (const name of STARTUP_OPTIONS)
    writer.unsetOption(name, true);
  heartbeat();
  const timer = setInterval(heartbeat, HEARTBEAT_MS);
  timer.unref?.();
  process.on("exit", () => writer.clearSync());
  publish();
  return {
    event: async ({ event }) => {
      const raw = event;
      const before = derive(store);
      const normalized = normalize(raw);
      for (const normalizedEvent of normalized) {
        apply(store, normalizedEvent);
      }
      const after = derive(store);
      notify(decideNotification(raw, {
        before,
        after,
        normalized,
        activeSessionID: store.activeSessionID
      }));
      publish();
    }
  };
};
export {
  PaneDash
};
