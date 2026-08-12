// @bun
// opencode-plugin/src/tui-state.ts
function rootSessionID(currentID, sessions) {
  let id = currentID;
  const visited = new Set;
  while (!visited.has(id)) {
    visited.add(id);
    const parentID = sessions.get(id)?.parentID;
    if (!parentID)
      return id;
    id = parentID;
  }
  return currentID;
}
function belongsToRoot(session, rootID, sessions) {
  let id = session.id;
  const visited = new Set;
  while (!visited.has(id)) {
    if (id === rootID)
      return true;
    visited.add(id);
    const parentID = sessions.get(id)?.parentID;
    if (!parentID)
      return false;
    id = parentID;
  }
  return false;
}
function deriveTuiState(currentID, input) {
  const sessions = new Map(input.map((session) => [session.id, session]));
  const rootID = rootSessionID(currentID, sessions);
  const relevant = input.filter((session) => belongsToRoot(session, rootID, sessions));
  const root = sessions.get(rootID);
  let status = "unknown";
  if (relevant.some((session) => session.pending))
    status = "needs_input";
  else if (relevant.some((session) => session.error))
    status = "error";
  else if (relevant.some((session) => session.runtime === "busy" || session.runtime === "retry"))
    status = "working";
  else if (relevant.some((session) => session.runtime === "idle"))
    status = "idle";
  else if (relevant.length > 0)
    status = "idle";
  return { rootID, status, title: root?.title, model: root?.model };
}

// opencode-plugin/src/sanitize.ts
function sanitize(value) {
  return value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120);
}

// opencode-plugin/src/writer.ts
var SPAWN_OPTIONS = { stdout: "ignore", stderr: "ignore" };
var defaultSpawn = (command, options) => Bun.spawn(command, options);

class TmuxWriter {
  pane;
  spawn;
  pending = Promise.resolve();
  draining = false;
  generation = 0;
  completedGeneration = 0;
  desired = new Map;
  confirmed = new Map;
  constructor(pane, spawn = defaultSpawn) {
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
      if (await this.spawn(command, SPAWN_OPTIONS).exited === 0) {
        for (const [name, value] of changes)
          this.confirmed.set(name, value);
      }
    } catch {}
  }
}

// opencode-plugin/src/tui.ts
var HEARTBEAT_MS = 20000;
var ROUTE_POLL_MS = 250;
var OPTIONS = [
  "@pane_dash_status",
  "@pane_dash_status_since",
  "@pane_dash_heartbeat",
  "@pane_dash_title",
  "@pane_dash_model",
  "@pane_dash_opencode_session"
];
function currentSessionID(api) {
  const route = api.route.current;
  const id = route.name === "session" ? route.params?.sessionID : undefined;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
function lastMessage(sessionID, api) {
  return api.state.session.messages(sessionID).at(-1);
}
function snapshot(sessionID, api, errored) {
  const session = api.state.session.get(sessionID);
  const status = api.state.session.status(sessionID)?.type;
  const message = lastMessage(sessionID, api);
  return {
    id: sessionID,
    parentID: session?.parentID,
    title: session?.title,
    model: session?.model?.id ?? (message?.role === "assistant" ? message.modelID : undefined),
    runtime: status === "busy" || status === "retry" || status === "idle" ? status : undefined,
    pending: api.state.session.permission(sessionID).length > 0 || api.state.session.question(sessionID).length > 0,
    error: errored.has(sessionID) || message?.role === "assistant" && message.error !== undefined
  };
}
function rootID(sessionID, api) {
  let id = sessionID;
  const visited = new Set;
  while (!visited.has(id)) {
    visited.add(id);
    const parentID = api.state.session.get(id)?.parentID;
    if (!parentID)
      return id;
    id = parentID;
  }
  return sessionID;
}
function startTuiProducer(api, runtime) {
  const known = new Set;
  const errored = new Set;
  let routeID;
  let treeGeneration = 0;
  const heartbeat = () => runtime.writer.setOption("@pane_dash_heartbeat", String(Math.floor(runtime.now() / 1000)), true);
  const publish = () => {
    const current = currentSessionID(api);
    if (!current || !api.state.ready || !api.state.session.get(current)) {
      runtime.writer.setOption("@pane_dash_status", "unknown");
      runtime.writer.unsetOption("@pane_dash_title");
      runtime.writer.unsetOption("@pane_dash_model");
      runtime.writer.unsetOption("@pane_dash_opencode_session");
      return;
    }
    known.add(current);
    for (let id = current;id; ) {
      known.add(id);
      id = api.state.session.get(id)?.parentID;
    }
    const derived = deriveTuiState(current, [...known].map((id) => snapshot(id, api, errored)));
    const previous = runtime.writer.get("@pane_dash_status");
    runtime.writer.setOption("@pane_dash_status", derived.status);
    if (previous !== derived.status)
      runtime.writer.setOption("@pane_dash_status_since", String(Math.floor(runtime.now() / 1000)));
    if (derived.title === undefined)
      runtime.writer.unsetOption("@pane_dash_title");
    else
      runtime.writer.setOption("@pane_dash_title", derived.title);
    if (derived.model === undefined)
      runtime.writer.unsetOption("@pane_dash_model");
    else
      runtime.writer.setOption("@pane_dash_model", derived.model);
    runtime.writer.setOption("@pane_dash_opencode_session", derived.rootID);
  };
  const refreshTree = async (current) => {
    const generation = ++treeGeneration;
    const root = rootID(current, api), found = new Set([root]), queue = [root];
    while (queue.length) {
      const parent = queue.shift();
      let children;
      try {
        children = (await api.client.session.children({ sessionID: parent })).data ?? [];
      } catch {
        return;
      }
      for (const child of children)
        if (!found.has(child.id)) {
          found.add(child.id);
          queue.push(child.id);
        }
    }
    if (generation !== treeGeneration || currentSessionID(api) !== current)
      return;
    known.clear();
    for (const id of found)
      known.add(id);
    known.add(current);
    publish();
  };
  const checkRoute = () => {
    const current = currentSessionID(api);
    if (current !== routeID) {
      routeID = current;
      known.clear();
      treeGeneration += 1;
      publish();
      if (current)
        refreshTree(current);
    } else
      publish();
  };
  for (const option of OPTIONS)
    runtime.writer.unsetOption(option, true);
  heartbeat();
  checkRoute();
  const heartbeatTimer = runtime.setInterval(heartbeat, HEARTBEAT_MS);
  const routeTimer = runtime.setInterval(checkRoute, ROUTE_POLL_MS);
  const relevant = ["session.status", "session.idle", "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected", "session.error", "session.created", "session.updated", "session.deleted", "message.updated"];
  for (const type of relevant)
    api.event.on(type, (event) => {
      const id = event?.properties?.sessionID ?? event?.properties?.info?.id;
      if (typeof id === "string" && routeID && rootID(id, api) === rootID(routeID, api))
        known.add(id);
      if (type === "session.error" && typeof id === "string")
        errored.add(id);
      if (type === "session.status" && typeof id === "string" && (event.properties.status?.type === "busy" || event.properties.status?.type === "retry"))
        errored.delete(id);
      queueMicrotask(publish);
      if ((type === "session.created" || type === "session.deleted") && routeID)
        refreshTree(routeID);
    });
  api.lifecycle.onDispose(async () => {
    treeGeneration += 1;
    runtime.clearInterval(heartbeatTimer);
    runtime.clearInterval(routeTimer);
    for (const option of OPTIONS)
      runtime.writer.unsetOption(option, true);
    await runtime.writer.flush();
    runtime.writer.clearSync();
  });
}
var plugin = {
  id: "pane-dash",
  tui: async (api) => {
    const pane = process.env.TMUX_PANE;
    if (!pane)
      return;
    startTuiProducer(api, {
      writer: new TmuxWriter(pane),
      now: Date.now,
      setInterval: (handler, milliseconds) => setInterval(handler, milliseconds),
      clearInterval: (timer) => clearInterval(timer)
    });
  }
};
var tui_default = plugin;
export {
  tui_default as default
};
