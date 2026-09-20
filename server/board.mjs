import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { operations, validate } from "./contracts.mjs";
import { validateExecution } from "./execution.mjs";
const key = (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const must = (test, message, status = 400) => {
  if (!test) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }
};
const parse = (row) => (row ? JSON.parse(row.data) : null);
export class Blackboard extends EventEmitter {
  constructor(file = ":memory:") {
    super();
    this.setMaxListeners(0);
    if (file !== ":memory:")
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, channel TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_channel_type ON records(channel,type);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,actor TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_channel ON events(channel,seq);
      CREATE TABLE IF NOT EXISTS credentials(hash TEXT PRIMARY KEY,actor TEXT NOT NULL,channel TEXT);
      CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,channel TEXT NOT NULL,role TEXT NOT NULL,stream TEXT NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS retries(actor TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,output TEXT NOT NULL,PRIMARY KEY(actor,key));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    // Launcher diagnostics can contain private runtime errors. Keep them outside
    // agent records and shared event payloads; only the human sees these reports.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS agent_execution(agent TEXT PRIMARY KEY,data TEXT NOT NULL)",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS message_reads(actor TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(actor,message));
      CREATE INDEX IF NOT EXISTS messages_conversation ON records(channel,type,json_extract(data,'$.directAgentId'),json_extract(data,'$.sequence'));`);
    const owner = this.db
      .prepare("SELECT value FROM settings WHERE key='owner'")
      .get();
    this.ownerToken = owner?.value || secret();
    if (!owner) {
      this.db
        .prepare("INSERT INTO settings VALUES(?,?)")
        .run("owner", this.ownerToken);
      this.db
        .prepare("INSERT INTO credentials VALUES(?,?,?)")
        .run(digest(this.ownerToken), "human", null);
    }
    if (file !== ":memory:")
      for (const path of [file, file + "-wal", file + "-shm"])
        if (existsSync(path)) chmodSync(path, 0o600);
  }
  close() {
    this.db.close();
  }
  get(id) {
    return parse(
      this.db.prepare("SELECT data FROM records WHERE id=?").get(id),
    );
  }
  list(channel, type) {
    return this.db
      .prepare(
        "SELECT data FROM records WHERE channel=? AND type=? ORDER BY rowid",
      )
      .all(channel, type)
      .map(parse);
  }
  put(record) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        record.id,
        record.channelId || record.id,
        record.type,
        JSON.stringify(record),
      );
    return record;
  }
  new(type, channelId, data) {
    return this.put({
      id: key(type.slice(0, 2)),
      type,
      channelId,
      version: 1,
      createdAt: Date.now(),
      ...data,
    });
  }
  update(record, changes) {
    return this.put({ ...record, ...changes, version: record.version + 1 });
  }
  auth(token) {
    const row = this.db
      .prepare("SELECT actor,channel FROM credentials WHERE hash=?")
      .get(digest(token || ""));
    must(row, "Invalid session. Join this mission again.", 401);
    return {
      id: row.actor,
      channelId: row.channel,
      human: row.actor === "human",
    };
  }
  channels(actor, { archived = false } = {}) {
    must(actor.human, "Only the human can list all missions.", 403);
    return this.db
      .prepare(
        "SELECT data FROM records WHERE type='mission' AND COALESCE(json_extract(data,'$.archived'),0)=? ORDER BY rowid",
      )
      .all(Number(archived))
      .map(parse);
  }
  access(actor, id) {
    must(
      actor.human || actor.channelId === id,
      "This identity cannot access that mission.",
      403,
    );
    const channel = this.get(id);
    must(channel?.type === "mission", "Mission not found", 404);
    return channel;
  }
  record(channel, id, type) {
    const item = this.get(id);
    must(
      item &&
        (item.channelId || item.id) === channel.id &&
        (!type || item.type === type),
      "Record not found in this mission",
      404,
    );
    return item;
  }
  readable(actor, channel, id, type) {
    const item = this.record(channel, id, type);
    must(
      !item.directAgentId || actor.human || item.directAgentId === actor.id,
      "Record not found in this mission",
      404,
    );
    return item;
  }
  directAgent(actor, channel, id) {
    const agent = this.record(channel, id, "agent");
    must(
      actor.human || agent.id === actor.id,
      "Private conversations are between the human and one agent.",
      403,
    );
    return agent;
  }
  references(actor, channel, ids, directAgentId = null) {
    for (const id of ids) {
      const record = this.readable(actor, channel, id);
      must(
        !record.directAgentId || record.directAgentId === directAgentId,
        "A private message can only be referenced inside the same private conversation.",
        403,
      );
    }
  }
  human(actor) {
    must(actor.human, "The human must make this change.", 403);
  }
  organize(actor, channel) {
    must(
      actor.human ||
        channel.coordinatorId === actor.id ||
        !channel.coordinatorId,
      "Ask the coordinator to organize this work.",
      403,
    );
  }
  version(item, version) {
    must(
      item.version === version,
      "This record changed. Read the current version before saving.",
      409,
    );
  }
  event(channel, actor, type, data) {
    const at = Date.now();
    const result = this.db
      .prepare(
        "INSERT INTO events(channel,actor,type,data,at) VALUES(?,?,?,?,?)",
      )
      .run(channel, actor, type, JSON.stringify(data), at);
    return Number(result.lastInsertRowid);
  }
  message(channel, actor, body, extra = {}) {
    const m = this.new("message", channel.id, {
      authorId: actor.id,
      streamId: channel.defaultStreamId,
      body,
      kind: "system",
      audience: "everyone",
      refs: [],
      threadId: null,
      removed: false,
      directAgentId: null,
      visibility: "public",
      ...extra,
    });
    m.sequence = this.event(channel.id, actor.id, "message", m);
    this.put(m);
    return m;
  }
  actorView(a, channel, viewer) {
    return {
      ...a,
      ...(viewer?.human
        ? {
            execution: parse(
              this.db
                .prepare("SELECT data FROM agent_execution WHERE agent=?")
                .get(a.id),
            ),
          }
        : {}),
      role: channel.coordinatorId === a.id ? "coordinator" : "agent",
      online: Date.now() - a.lastSeen < 45000,
    };
  }
  context(actor, id) {
    const channel = this.access(actor, id);
    const agents = this.list(id, "agent").map((a) =>
      this.actorView(a, channel, actor),
    );
    const cursor = Number(
      this.db
        .prepare("SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE channel=?")
        .get(id).n,
    );
    if (!actor.human) {
      const a = this.get(actor.id);
      this.put({ ...a, delivered: Math.max(a.delivered || 0, cursor) });
    }
    const limit = actor.human ? Number.MAX_SAFE_INTEGER : 30;
    const roster = actor.human
      ? agents
      : [
          ...new Map(
            [
              this.get(actor.id),
              channel.coordinatorId ? this.get(channel.coordinatorId) : null,
              ...agents,
            ]
              .filter(Boolean)
              .map((a) => [a.id, this.actorView(a, channel, actor)]),
          ).values(),
        ].slice(0, limit);
    const workstreams = this.list(id, "workstream");
    const tasks = this.list(id, "task");
    const requests = this.list(id, "request");
    const assignments = this.list(id, "assignment").filter(
      (a) => a.status === "pending",
    );
    return {
      mission: channel,
      workstreams: actor.human
        ? workstreams
        : [
            ...workstreams.filter(
              (w) => w.isDefault || w.id === this.get(actor.id).streamId,
            ),
            ...workstreams.filter(
              (w) => !w.isDefault && w.id !== this.get(actor.id).streamId,
            ),
          ].slice(0, limit),
      agents: roster,
      assignments: (actor.human || channel.coordinatorId === actor.id
        ? assignments
        : assignments.filter((a) => a.agentId === actor.id)
      ).slice(-limit),
      requests: requests.slice(-limit),
      tasks: actor.human
        ? tasks
        : [
            ...tasks.filter((t) => t.agentIds.includes(actor.id)).reverse(),
            ...tasks.filter((t) => !t.agentIds.includes(actor.id)).reverse(),
          ].slice(0, limit),
      totals: {
        agents: agents.length,
        workstreams: workstreams.length,
        assignments: assignments.length,
        requests: requests.length,
        tasks: tasks.length,
      },
      messages: this.messages(actor, {
        channel_id: id,
        stream_id: channel.defaultStreamId,
        limit: actor.human ? 60 : 20,
      }).messages,
      directMessages: this.directConversations(actor, channel),
      privateMessages: actor.human
        ? []
        : this.messages(actor, {
            channel_id: id,
            direct_agent_id: actor.id,
            limit: 20,
          }).messages,
      inboxUnread: actor.human
        ? this.searchMessages(actor, {
            channel_id: id,
            view: "inbox",
            unread: true,
            count: true,
          })
        : 0,
      cursor,
      serverTime: Date.now(),
      selfId: actor.id,
    };
  }
  records(actor, { channel_id, type, offset = 0, limit = 50 }) {
    const c = this.access(actor, channel_id);
    const total = Number(
      this.db
        .prepare("SELECT COUNT(*) AS n FROM records WHERE channel=? AND type=?")
        .get(c.id, type).n,
    );
    const items = this.db
      .prepare(
        "SELECT data FROM records WHERE channel=? AND type=? ORDER BY rowid LIMIT ? OFFSET ?",
      )
      .all(c.id, type, limit, offset)
      .map(parse)
      .map((item) =>
        type === "agent" ? this.actorView(item, c, actor) : item,
      );
    return {
      items,
      total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
    };
  }
  messages(
    actor,
    {
      channel_id,
      stream_id,
      thread_id,
      direct_agent_id,
      before = Number.MAX_SAFE_INTEGER,
      limit = 50,
    },
  ) {
    const c = this.access(actor, channel_id);
    if (stream_id) this.record(c, stream_id, "workstream");
    const parent = thread_id
      ? this.readable(actor, c, thread_id, "message")
      : null;
    if (direct_agent_id) this.directAgent(actor, c, direct_agent_id);
    must(
      !direct_agent_id || !stream_id,
      "Choose a public workstream or a private conversation.",
    );
    must(
      !parent || !direct_agent_id || parent.directAgentId === direct_agent_id,
      "Thread belongs to a different conversation.",
    );
    const directId = parent?.directAgentId || direct_agent_id || null;
    const predicate = thread_id
      ? "json_extract(data,'$.threadId')=?"
      : directId
        ? "json_extract(data,'$.directAgentId')=?"
        : "json_extract(data,'$.streamId')=? AND json_extract(data,'$.threadId') IS NULL";
    const rows = this.db
      .prepare(
        `SELECT data FROM records WHERE channel=? AND type='message' AND json_extract(data,'$.sequence')<? AND ${predicate} AND json_extract(data,'$.directAgentId') IS ? ORDER BY json_extract(data,'$.sequence') DESC LIMIT ?`,
      )
      .all(
        c.id,
        before,
        thread_id || directId || stream_id || c.defaultStreamId,
        directId,
        limit + 1,
      )
      .map(parse);
    const more = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return { messages: page, more, nextBefore: page[0]?.sequence || 0 };
  }
  searchMessages(
    actor,
    {
      channel_id,
      view = "all",
      query = "",
      visibility = "all",
      agent_id,
      audience,
      stream_id,
      direct_agent_id,
      unread = false,
      before = Number.MAX_SAFE_INTEGER,
      limit = 50,
      count = false,
    },
  ) {
    const c = this.access(actor, channel_id);
    if (view !== "all" || unread) this.human(actor);
    if (direct_agent_id) this.directAgent(actor, c, direct_agent_id);
    const field = (name) => `json_extract(m.data,'$.${name}')`;
    const clauses = [
      "m.channel=?",
      "m.type='message'",
      `${field("sequence")}<?`,
    ];
    const values = [c.id, before];
    if (!actor.human) {
      clauses.push(
        `(${field("directAgentId")} IS NULL OR ${field("directAgentId")}=?)`,
      );
      values.push(actor.id);
    }
    if (view === "sent")
      clauses.push(
        `${field("authorId")}='human'`,
        `${field("kind")}!='system'`,
      );
    if (view === "inbox")
      clauses.push(
        `${field("authorId")}!='human'`,
        `${field("kind")}!='system'`,
        `${field("removed")}=0`,
        `(${field("directAgentId")} IS NOT NULL OR ${field("audience")}='human' OR EXISTS(SELECT 1 FROM records p WHERE p.id=${field("threadId")} AND json_extract(p.data,'$.authorId')='human'))`,
      );
    if (visibility !== "all")
      clauses.push(
        `${field("directAgentId")} IS ${visibility === "private" ? "NOT " : ""}NULL`,
      );
    if (agent_id) {
      this.record(c, agent_id, "agent");
      clauses.push(
        `(${field("directAgentId")}=? OR ${field("audience")}=? OR ${field("addressedAgentId")}=? OR ${field("authorId")}=?)`,
      );
      values.push(agent_id, agent_id, agent_id, agent_id);
    }
    if (audience) {
      clauses.push(
        `${field("audience")}=?`,
        `${field("directAgentId")} IS NULL`,
      );
      values.push(audience);
    }
    if (stream_id) {
      this.record(c, stream_id, "workstream");
      clauses.push(
        `${field("streamId")}=?`,
        `${field("directAgentId")} IS NULL`,
      );
      values.push(stream_id);
    }
    if (direct_agent_id) {
      clauses.push(`${field("directAgentId")}=?`);
      values.push(direct_agent_id);
    }
    if (query) {
      clauses.push(`instr(lower(${field("body")}),lower(?))>0`);
      values.push(query);
    }
    const seen =
      "EXISTS(SELECT 1 FROM message_reads r WHERE r.actor='human' AND r.message=m.id)";
    if (unread) clauses.push(`NOT ${seen}`);
    const where = clauses.join(" AND ");
    if (count)
      return Number(
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM records m WHERE ${where}`)
          .get(...values).n,
      );
    const rows = this.db
      .prepare(
        `SELECT m.data, ${seen} AS seen FROM records m WHERE ${where} ORDER BY ${field("sequence")} DESC LIMIT ?`,
      )
      .all(...values, limit + 1);
    const messages = rows
      .slice(0, limit)
      .map((row) => ({ ...parse(row), seen: !!row.seen }));
    return {
      messages,
      more: rows.length > limit,
      nextBefore: messages.at(-1)?.sequence || 0,
    };
  }
  directConversations(actor, c) {
    const rows = this.db
      .prepare(
        `SELECT json_extract(data,'$.directAgentId') AS agentId, MAX(json_extract(data,'$.sequence')) AS latest
      FROM records WHERE channel=? AND type='message' AND json_extract(data,'$.directAgentId') IS NOT NULL
      AND (? OR json_extract(data,'$.directAgentId')=?) GROUP BY agentId ORDER BY latest DESC`,
      )
      .all(c.id, Number(actor.human), actor.id);
    const latest = this.db.prepare(
      "SELECT data FROM records WHERE channel=? AND type='message' AND json_extract(data,'$.directAgentId')=? AND json_extract(data,'$.sequence')=?",
    );
    const unread = this.db
      .prepare(`SELECT COUNT(*) AS n FROM records m WHERE m.channel=? AND m.type='message'
      AND json_extract(m.data,'$.directAgentId')=? AND json_extract(m.data,'$.authorId')!='human' AND json_extract(m.data,'$.removed')=0
      AND NOT EXISTS(SELECT 1 FROM message_reads r WHERE r.actor='human' AND r.message=m.id)`);
    return rows.map((row) => {
      const message = parse(latest.get(c.id, row.agentId, row.latest));
      return {
        agentId: row.agentId,
        lastMessage: {
          id: message.id,
          authorId: message.authorId,
          createdAt: message.createdAt,
          sequence: message.sequence,
          preview:
            message.body.length > 240
              ? message.body.slice(0, 240) + "…"
              : message.body,
        },
        unread: actor.human ? Number(unread.get(c.id, row.agentId).n) : 0,
      };
    });
  }
  updates(actor, { channel_id, after = 0, acknowledge }) {
    const c = this.access(actor, channel_id);
    const agent = !actor.human ? this.get(actor.id) : null;
    if (acknowledge !== undefined && agent) {
      must(
        acknowledge <= (agent.delivered || 0),
        "Cannot acknowledge updates not delivered",
        409,
      );
      this.put({ ...agent, cursor: Math.max(agent.cursor || 0, acknowledge) });
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE channel=? AND seq>? ORDER BY seq LIMIT 100",
      )
      .all(c.id, after);
    const next = rows.at(-1)?.seq || after;
    const relevant = rows.filter((e) => {
      if (actor.human) return true;
      if (e.actor === actor.id) return false;
      const data = JSON.parse(e.data);
      const directAgentId =
        data.directAgentId ||
        (data.messageId ? this.get(data.messageId)?.directAgentId : null);
      if (directAgentId) return directAgentId === actor.id;
      if (e.type !== "message")
        return (
          !data.agentId ||
          data.agentId === actor.id ||
          actor.id === c.coordinatorId
        );
      return (
        data.notifyAgentIds?.includes(actor.id) ||
        data.audience === actor.id ||
        (data.audience === "coordinator" && actor.id === c.coordinatorId) ||
        (data.audience === "everyone" &&
          (data.streamId === c.defaultStreamId ||
            data.streamId === agent.streamId ||
            actor.id === c.coordinatorId)) ||
        (e.actor === "human" && data.audience === "everyone")
      );
    });
    if (agent)
      this.put({
        ...this.get(actor.id),
        delivered: Math.max(this.get(actor.id).delivered || 0, Number(next)),
      });
    return {
      events: relevant.map((e) => ({
        sequence: Number(e.seq),
        type: e.type,
        actorId: e.actor,
        at: e.at,
        data: JSON.parse(e.data),
        ...(JSON.parse(e.data).directAgentId
          ? {
              replyInstruction:
                "Private human-agent message. Reply using message_post with thread_id set to this message id, or direct_agent_id set to your own agent id. Keep its contents private unless the human asks to share them.",
            }
          : {}),
      })),
      cursor: Number(next),
      more: rows.length === 100,
    };
  }
  heartbeat(actor, state, execution) {
    must(!actor.human, "Agent identity required");
    const a = this.get(actor.id);
    const c = this.access(actor, a.channelId);
    let executionChanged = false;
    if (execution !== undefined) {
      const report = validateExecution(execution);
      const before = parse(
        this.db
          .prepare("SELECT data FROM agent_execution WHERE agent=?")
          .get(a.id),
      );
      const { reportedAt: _reportedAt, ...previous } = before || {};
      executionChanged = JSON.stringify(previous) !== JSON.stringify(report);
      this.db
        .prepare(
          "INSERT INTO agent_execution(agent,data) VALUES(?,?) ON CONFLICT(agent) DO UPDATE SET data=excluded.data",
        )
        .run(a.id, JSON.stringify({ ...report, reportedAt: Date.now() }));
    }
    const status = ["idle", "working", "paused", "error", "offline"].includes(
      state,
    )
      ? state
      : a.status;
    this.put({ ...a, lastSeen: status === "offline" ? 0 : Date.now(), status });
    if (executionChanged || a.status !== status) this.emit("change", c.id);
    return {
      control: a.control,
      missionState: c.archived ? "archived" : c.state,
      role: c.coordinatorId === a.id ? "coordinator" : "agent",
    };
  }
  invitation(token) {
    const row = this.db
      .prepare("SELECT * FROM invitations WHERE hash=?")
      .get(digest(token));
    must(
      row && !row.revoked && row.expires > Date.now(),
      "This invitation is invalid or expired.",
      401,
    );
    must(
      !this.get(row.channel)?.archived,
      "Channel is archived. Restore it before inviting agents.",
      409,
    );
    return row;
  }
  join({
    invitation,
    name,
    runtime,
    capabilities = "",
    stream,
    role,
    registration_id,
  }) {
    must(
      typeof invitation === "string" && invitation.length <= 200,
      "A valid invitation is required",
    );
    must(
      role === undefined || ["agent", "coordinator"].includes(role),
      "Only Agent and Coordinator roles exist",
    );
    must(
      registration_id === undefined ||
        (typeof registration_id === "string" &&
          registration_id.length >= 16 &&
          registration_id.length <= 150),
      "Invalid registration ID",
    );
    must(
      ["claude", "codex"].includes(runtime),
      "Runtime must be claude or codex",
    );
    must(
      typeof name === "string" && name.trim().length > 0 && name.length <= 100,
      "Use a name of 1–100 characters",
    );
    must(
      typeof capabilities === "string" && capabilities.length <= 2000,
      "Capabilities are too long",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const invite = this.invitation(invitation);
      const input = JSON.stringify([name, runtime, capabilities, stream, role]);
      if (registration_id) {
        const previous = this.db
          .prepare("SELECT * FROM retries WHERE actor=? AND key=?")
          .get(invite.id, registration_id);
        if (previous) {
          must(
            previous.input === input,
            "Registration ID was reused with different parameters",
            409,
          );
          this.db.exec("COMMIT");
          return JSON.parse(previous.output);
        }
      }
      must(
        !role || role === invite.role,
        "The requested role must match the invitation",
        403,
      );
      const c = this.get(invite.channel);
      must(c.state !== "closed", "Mission is closed", 409);
      if (invite.role === "coordinator")
        must(!c.coordinatorId, "This mission already has a coordinator.", 409);
      const streamId = stream
        ? this.list(c.id, "workstream").find(
            (s) => s.id === stream || s.name === stream,
          )?.id
        : invite.stream;
      must(streamId, "Workstream not found");
      const w = this.record(c, streamId, "workstream");
      must(!w.archived, "Workstream is archived");
      const agent = this.new("agent", c.id, {
        name: name.trim(),
        runtime,
        capabilities,
        streamId,
        lastSeen: Date.now(),
        status: "idle",
        control: "resume",
        direction: "",
        cursor: 0,
        delivered: 0,
        humanDirected: false,
      });
      const token = secret();
      this.db
        .prepare("INSERT INTO credentials VALUES(?,?,?)")
        .run(digest(token), agent.id, c.id);
      if (invite.role === "coordinator")
        this.update(c, { coordinatorId: agent.id });
      this.message(
        c,
        { id: agent.id },
        `${agent.name} joined as ${invite.role === "coordinator" ? "Coordinator" : "Agent"}.`,
      );
      const result = {
        agent: this.actorView(agent, this.get(c.id)),
        token,
        channelId: c.id,
      };
      if (registration_id)
        this.db
          .prepare("INSERT INTO retries VALUES(?,?,?,?)")
          .run(invite.id, registration_id, input, JSON.stringify(result));
      this.db.exec("COMMIT");
      this.emit("change", c.id);
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  execute(actor, operation, raw, retryKey) {
    const p = validate(operation, raw);
    if (operations[operation].read) {
      if (operation === "context_read")
        return this.context(actor, p.channel_id);
      if (operation === "messages_read") return this.messages(actor, p);
      if (operation === "updates_read") return this.updates(actor, p);
      if (operation === "records_read") return this.records(actor, p);
      if (operation === "messages_search") return this.searchMessages(actor, p);
      const channel = this.access(actor, p.channel_id);
      const record = this.readable(actor, channel, p.id);
      return record.type === "agent"
        ? this.actorView(record, channel, actor)
        : record;
    }
    must(
      typeof retryKey === "string" &&
        retryKey.length > 0 &&
        retryKey.length <= 150,
      "A mutation idempotency key is required",
    );
    const input = JSON.stringify([operation, p]);
    if (operation === "mission_create" || operation === "mission_archive")
      this.human(actor);
    const previous = this.db
      .prepare("SELECT * FROM retries WHERE actor=? AND key=?")
      .get(actor.id, retryKey);
    if (previous) {
      must(
        previous.input === input,
        "Idempotency key was reused for a different change",
        409,
      );
      return JSON.parse(previous.output);
    }
    this.db.exec("BEGIN IMMEDIATE");
    let changed = p.channel_id;
    try {
      let c = p.channel_id ? this.access(actor, p.channel_id) : null;
      const me = !actor.human ? this.get(actor.id) : null;
      must(
        !c?.archived ||
          ["mission_archive", "messages_seen", "invitation_revoke"].includes(
            operation,
          ),
        "Channel is archived and read-only. Restore it before making changes.",
        409,
      );
      if (me) {
        must(
          (c.state === "active" && me.control !== "pause") ||
            (operation === "message_post" &&
              (p.audience === "human" ||
                p.direct_agent_id === actor.id ||
                (p.thread_id &&
                  this.readable(actor, c, p.thread_id, "message")
                    .directAgentId === actor.id))),
          "Work is paused. Read human instructions before continuing.",
          409,
        );
      }
      let result;
      switch (operation) {
        case "messages_seen": {
          this.human(actor);
          const seen = this.db.prepare(
            "INSERT OR IGNORE INTO message_reads(actor,message) VALUES(?,?)",
          );
          for (const id of p.message_ids) {
            this.readable(actor, c, id, "message");
            seen.run(actor.id, id);
          }
          result = { seen: p.message_ids.length };
          break;
        }
        case "mission_create": {
          this.human(actor);
          c = this.new("mission", null, {
            name: p.name,
            objective: p.objective,
            scope: p.scope,
            criteria: p.criteria.map((text) => ({
              id: key("cr"),
              text,
              met: false,
            })),
            coordinatorId: null,
            plan: "",
            state: "active",
            archived: false,
            archivedAt: null,
          });
          c.channelId = c.id;
          const w = this.new("workstream", c.id, {
            name: "Main",
            goal: p.objective,
            isDefault: true,
            archived: false,
          });
          c = this.update(c, { defaultStreamId: w.id });
          changed = c.id;
          this.message(
            c,
            actor,
            "Mission created. Read the objective, scope, and completion criteria.",
          );
          result = c;
          break;
        }
        case "mission_update": {
          this.human(actor);
          this.version(c, p.version);
          result = this.update(c, {
            name: p.name,
            objective: p.objective,
            scope: p.scope,
            criteria: p.criteria.map((x) => ({ ...x, id: x.id || key("cr") })),
          });
          this.update(this.get(c.defaultStreamId), { goal: p.objective });
          this.message(
            c,
            actor,
            "Human updated the mission instructions. Read the current objective, scope, and criteria.",
            { kind: "decision" },
          );
          break;
        }
        case "mission_archive": {
          this.human(actor);
          this.version(c, p.version);
          if (!!c.archived === p.archived) {
            result = c;
            break;
          }
          result = this.update(c, {
            archived: p.archived,
            archivedAt: p.archived ? Date.now() : null,
            state: c.state === "active" ? "paused" : c.state,
          });
          this.message(
            c,
            actor,
            p.archived
              ? "Human archived this channel. History is read-only; agents must stop work."
              : `Human restored this channel. Mission remains ${result.state} until the human resumes it.`,
            { kind: "decision" },
          );
          break;
        }
        case "mission_state": {
          this.human(actor);
          result = this.update(c, { state: p.state });
          this.message(c, actor, `Mission ${p.state}: ${p.reason}`, {
            kind: "decision",
          });
          break;
        }
        case "coordinator_set": {
          this.human(actor);
          this.version(c, p.version);
          const a = p.agent_id ? this.record(c, p.agent_id, "agent") : null;
          result = this.update(c, { coordinatorId: a?.id || null });
          this.message(
            c,
            actor,
            `${a ? `${a.name} is now the coordinator` : "Peer collaboration enabled"}. ${p.reason}`,
            { kind: "decision" },
          );
          break;
        }
        case "plan_update": {
          must(
            actor.human || c.coordinatorId === actor.id,
            "Only the coordinator or human updates the shared plan.",
            403,
          );
          this.version(c, p.version);
          this.references(actor, c, p.refs);
          result = this.update(c, { plan: p.plan });
          this.message(c, actor, p.plan, { kind: "decision", refs: p.refs });
          break;
        }
        case "stream_create": {
          this.organize(actor, c);
          result = this.new("workstream", c.id, {
            name: p.name,
            goal: p.goal,
            isDefault: false,
            archived: false,
          });
          this.message(
            c,
            actor,
            `Workstream opened: ${p.name}\nGoal: ${p.goal}`,
            { kind: "decision", refs: [result.id] },
          );
          break;
        }
        case "stream_update": {
          this.organize(actor, c);
          const w = this.record(c, p.stream_id, "workstream");
          this.version(w, p.version);
          must(
            !w.isDefault,
            "Edit the mission to update Main. Main cannot be archived.",
          );
          if (p.archived)
            must(
              !this.list(c.id, "agent").some((a) => a.streamId === w.id) &&
                !this.list(c.id, "assignment").some(
                  (a) => a.streamId === w.id && a.status === "pending",
                ),
              "Move agents and pending assignments before archiving this workstream.",
            );
          result = this.update(w, {
            name: p.name,
            goal: p.goal,
            archived: p.archived,
          });
          this.message(c, actor, `Workstream updated: ${p.name}\n${p.goal}`, {
            refs: [w.id],
          });
          break;
        }
        case "stream_join": {
          must(me, "Use assignment controls for existing agents.");
          must(
            !me.humanDirected,
            "A direct human assignment is active. Ask the human to release it.",
            403,
          );
          must(
            !c.coordinatorId || c.coordinatorId === actor.id,
            "Ask the coordinator for a workstream assignment.",
            403,
          );
          const w = this.record(c, p.stream_id, "workstream");
          must(!w.archived, "Workstream is archived");
          result = this.update(me, { streamId: w.id, direction: p.direction });
          this.message(c, actor, p.direction, {
            kind: "finding",
            streamId: w.id,
          });
          break;
        }
        case "assignment_create": {
          must(
            actor.human || c.coordinatorId === actor.id,
            "Coordinator or human required.",
            403,
          );
          const a = this.record(c, p.agent_id, "agent");
          const w = this.record(c, p.stream_id, "workstream");
          must(!w.archived, "Workstream is archived");
          must(
            actor.human || !a.humanDirected,
            "This agent has a direct human assignment. Ask the human to release it.",
            403,
          );
          for (const pending of this.list(c.id, "assignment").filter(
            (x) => x.agentId === a.id && x.status === "pending",
          ))
            this.update(pending, { status: "superseded" });
          result = this.new("assignment", c.id, {
            agentId: a.id,
            streamId: w.id,
            instruction: p.instruction,
            issuedBy: actor.id,
            status: "pending",
          });
          if (actor.human) this.update(a, { humanDirected: true });
          this.message(c, actor, `${a.name} → ${w.name}\n${p.instruction}`, {
            kind: "decision",
            audience: a.id,
            refs: [result.id],
          });
          break;
        }
        case "assignment_ack": {
          const a = this.record(c, p.assignment_id, "assignment");
          must(
            a.agentId === actor.id && a.status === "pending",
            "Only the assigned agent can acknowledge a pending assignment.",
            403,
          );
          const w = this.record(c, a.streamId, "workstream");
          must(!w.archived, "Workstream is archived");
          this.update(me, {
            streamId: a.streamId,
            direction: p.direction,
            status: "working",
          });
          result = this.update(a, {
            status: "acknowledged",
            acknowledgedAt: Date.now(),
          });
          this.message(c, actor, `Assignment acknowledged. ${p.direction}`, {
            kind: "finding",
            streamId: a.streamId,
            refs: [a.id],
          });
          break;
        }
        case "agent_control": {
          this.human(actor);
          const a = this.record(c, p.agent_id, "agent");
          result = this.update(
            a,
            p.control === "release"
              ? { humanDirected: false }
              : { control: p.control },
          );
          this.message(c, actor, `${a.name}: ${p.control}. ${p.reason}`, {
            kind: "decision",
            audience: a.id,
          });
          break;
        }
        case "direction_set": {
          must(me, "An agent declares its own direction.");
          result = this.update(me, { direction: p.direction });
          this.message(c, actor, p.direction, {
            kind: "finding",
            streamId: me.streamId,
          });
          break;
        }
        case "message_post": {
          const parent = p.thread_id
            ? this.readable(actor, c, p.thread_id, "message")
            : null;
          must(
            !parent ||
              !p.direct_agent_id ||
              parent.directAgentId === p.direct_agent_id,
            "Thread belongs to a different conversation.",
          );
          const directAgentId =
            parent?.directAgentId || p.direct_agent_id || null;
          if (directAgentId) this.directAgent(actor, c, directAgentId);
          must(
            !directAgentId ||
              ["everyone", "human", directAgentId].includes(p.audience) ||
              (p.audience === "coordinator" &&
                c.coordinatorId === directAgentId),
            "The audience must match the private conversation participant.",
          );
          must(
            !directAgentId || !p.stream_id,
            "Private messages do not belong to a public workstream.",
          );
          const streamId =
            parent?.streamId ||
            p.stream_id ||
            me?.streamId ||
            c.defaultStreamId;
          if (!directAgentId) {
            const w = this.record(c, streamId, "workstream");
            must(!w.archived, "Workstream is archived");
          }
          must(
            ["everyone", "coordinator", "human"].includes(p.audience) ||
              this.record(c, p.audience, "agent"),
            "Invalid audience",
          );
          this.references(actor, c, p.refs, directAgentId);
          result = this.message(c, actor, p.body, {
            kind: p.kind,
            audience: directAgentId
              ? actor.human
                ? directAgentId
                : "human"
              : p.audience,
            addressedAgentId:
              directAgentId ||
              (p.audience === "coordinator"
                ? c.coordinatorId
                : !["everyone", "human"].includes(p.audience)
                  ? p.audience
                  : null),
            directAgentId,
            visibility: directAgentId ? "private" : "public",
            streamId: directAgentId ? null : streamId,
            threadId: parent?.id || null,
            refs: p.refs,
          });
          break;
        }
        case "message_edit": {
          this.human(actor);
          const m = this.record(c, p.message_id, "message");
          must(p.remove || p.body, "A message body is required");
          result = this.update(m, {
            body: p.remove ? "Message removed by the human." : p.body,
            removed: p.remove,
            editedAt: Date.now(),
          });
          this.event(c.id, actor.id, "message_edited", {
            messageId: m.id,
            directAgentId: m.directAgentId || null,
          });
          break;
        }
        case "agents_request": {
          must(
            actor.human || c.coordinatorId === actor.id,
            "Only the coordinator requests additional agents.",
            403,
          );
          if (p.stream_id) this.record(c, p.stream_id, "workstream");
          result = this.new("request", c.id, {
            count: p.count,
            capabilities: p.capabilities,
            reason: p.reason,
            streamId: p.stream_id || c.defaultStreamId,
            requestedBy: actor.id,
            status: "open",
            response: "",
          });
          this.message(
            c,
            actor,
            `Request for ${p.count} additional agents\nCapabilities: ${p.capabilities}\n${p.reason}`,
            { kind: "question", audience: "human", refs: [result.id] },
          );
          break;
        }
        case "request_respond": {
          this.human(actor);
          const r = this.record(c, p.request_id, "request");
          result = this.update(r, { status: p.status, response: p.response });
          this.message(c, actor, p.response, {
            audience: "coordinator",
            refs: [r.id],
          });
          break;
        }
        case "task_create": {
          const manager =
            actor.human || c.coordinatorId === actor.id || !c.coordinatorId;
          const agentIds = [
            ...new Set(p.agent_ids.length ? p.agent_ids : me ? [me.id] : []),
          ];
          must(
            manager || (agentIds.length === 1 && agentIds[0] === actor.id),
            "Create a task for yourself; ask the coordinator to allocate other agents.",
            403,
          );
          const streamId = p.stream_id || me?.streamId || c.defaultStreamId;
          must(
            !this.record(c, streamId, "workstream").archived,
            "Workstream is archived",
          );
          agentIds.forEach((id) => this.record(c, id, "agent"));
          must(
            p.mode === "parallel" || agentIds.length <= 1,
            "An individual task can have at most one agent.",
          );
          result = this.new("task", c.id, {
            title: p.title,
            description: p.description,
            criteria: p.criteria,
            mode: p.mode,
            agentIds,
            streamId,
            status: "open",
            summary: "",
            refs: [],
            createdBy: actor.id,
            updatedBy: actor.id,
            updatedAt: Date.now(),
          });
          this.message(c, actor, `Task planned: ${p.title}`, {
            streamId,
            refs: [result.id],
            notifyAgentIds: agentIds,
          });
          break;
        }
        case "task_update": {
          const t = this.record(c, p.task_id, "task");
          this.version(t, p.version);
          const manager =
            actor.human || c.coordinatorId === actor.id || !c.coordinatorId;
          must(
            manager || t.agentIds.includes(actor.id),
            "Only an assigned agent, coordinator or human can update this task.",
            403,
          );
          if (p.agent_ids) {
            must(manager, "Ask the coordinator to change assignments.", 403);
            p.agent_ids.forEach((id) => this.record(c, id, "agent"));
            must(
              t.mode === "parallel" || p.agent_ids.length <= 1,
              "An individual task can have at most one agent.",
            );
          }
          this.references(actor, c, p.refs);
          result = this.update(t, {
            status: p.status,
            summary: p.summary,
            refs: p.refs,
            ...(p.agent_ids ? { agentIds: [...new Set(p.agent_ids)] } : {}),
            updatedBy: actor.id,
            updatedAt: Date.now(),
          });
          this.message(c, actor, `${t.title}: ${p.status}\n${p.summary}`, {
            streamId: t.streamId,
            refs: [t.id, ...p.refs],
            notifyAgentIds: [...new Set([...t.agentIds, ...result.agentIds])],
          });
          break;
        }
        case "invitation_create": {
          this.human(actor);
          const streamId = p.stream_id || c.defaultStreamId;
          must(
            !this.record(c, streamId, "workstream").archived,
            "Workstream is archived",
          );
          const token = secret();
          const id = key("in");
          this.db
            .prepare(
              "INSERT INTO invitations(id,hash,channel,role,stream,expires) VALUES(?,?,?,?,?,?)",
            )
            .run(
              id,
              digest(token),
              c.id,
              p.role,
              streamId,
              Date.now() + 86400000,
            );
          result = {
            id,
            token,
            role: p.role,
            expiresAt: Date.now() + 86400000,
          };
          break;
        }
        case "invitation_revoke": {
          this.human(actor);
          const row = this.db
            .prepare("SELECT * FROM invitations WHERE id=? AND channel=?")
            .get(p.invitation_id, c.id);
          must(row, "Invitation not found", 404);
          this.db
            .prepare("UPDATE invitations SET revoked=1 WHERE id=?")
            .run(row.id);
          result = { revoked: true };
          break;
        }
        default:
          throw new Error("Unknown operation");
      }
      this.db
        .prepare("INSERT INTO retries VALUES(?,?,?,?)")
        .run(actor.id, retryKey, input, JSON.stringify(result));
      this.db.exec("COMMIT");
      if (operation !== "messages_seen") this.emit("change", changed);
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
