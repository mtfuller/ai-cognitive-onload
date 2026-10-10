#!/usr/bin/env node
// Built by scripts/build.mjs from src/. Do not edit.

// src/node/service.ts
import { EventEmitter } from "node:events";

// plugins/sysedit/core/model.ts
var LEVELS = ["services", "modules", "functions"];
var NODE_KINDS = [
  "endpoint",
  "config",
  "service",
  "module",
  "function",
  "datastore",
  "topic",
  "worker",
  "job",
  "external"
];
var EDGE_KINDS = [
  "call",
  "route",
  "event",
  "http",
  "read",
  "write",
  "config",
  "branch"
];
function edgeId(edge) {
  return edge.id ?? `${edge.from}->${edge.to}`;
}
function nodeLevel(node) {
  if (node.level) return node.level;
  switch (node.kind) {
    case "service":
    case "external":
    case "datastore":
    case "topic":
    case "endpoint":
    case "config":
      return "services";
    case "module":
    case "worker":
    case "job":
      return "modules";
    default:
      return "functions";
  }
}
function emptyModel(commit = "unknown") {
  return { version: 1, commit, nodes: [], edges: [], flows: [] };
}
function indexModel(model) {
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const edges = new Map(model.edges.map((e) => [edgeId(e), e]));
  return { nodes, edges };
}
function mergeModels(base, incoming) {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of incoming.nodes) nodes.set(n.id, n);
  const edges = new Map(base.edges.map((e) => [edgeId(e), e]));
  for (const e of incoming.edges) edges.set(edgeId(e), e);
  const flows = new Map(base.flows.map((f) => [f.id, f]));
  for (const f of incoming.flows) flows.set(f.id, f);
  return {
    ...base,
    ...incoming,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    flows: [...flows.values()]
  };
}
function ownerAt(model, level) {
  const rank = (l) => LEVELS.indexOf(l);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const visible = (n) => rank(nodeLevel(n)) <= rank(level);
  return (id) => {
    let cur = byId.get(id);
    const seen = /* @__PURE__ */ new Set();
    while (cur && !visible(cur)) {
      if (seen.has(cur.id) || !cur.parent) return void 0;
      seen.add(cur.id);
      cur = byId.get(cur.parent);
    }
    return cur?.id;
  };
}
function atLevel(model, level) {
  const rank = (l) => LEVELS.indexOf(l);
  const owner = ownerAt(model, level);
  const nodes = model.nodes.filter((n) => rank(nodeLevel(n)) <= rank(level));
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  for (const e of model.edges) {
    const from = owner(e.from);
    const to = owner(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(from === e.from && to === e.to ? e : { ...e, id: void 0, from, to });
  }
  return { ...model, nodes, edges };
}
function flowSlice(model, flowId) {
  const flow = model.flows.find((f) => f.id === flowId);
  if (!flow) return { ...model, nodes: [], edges: [], flows: [] };
  const { edges } = indexModel(model);
  const ids = /* @__PURE__ */ new Set([flow.entryNode]);
  const keep = [];
  for (const step of flow.steps) {
    const e = edges.get(step.edge);
    if (!e) continue;
    keep.push(e);
    ids.add(e.from);
    ids.add(e.to);
  }
  return {
    ...model,
    nodes: model.nodes.filter((n) => ids.has(n.id)),
    edges: keep,
    flows: [flow]
  };
}
function modelStats(model) {
  return {
    nodes: model.nodes.length,
    edges: model.edges.length,
    inferred: model.edges.filter((e) => e.confidence === "inferred").length,
    external: model.nodes.filter((n) => n.external).length,
    flows: model.flows.length
  };
}

// plugins/sysedit/core/changeset.ts
var QUESTION_CATEGORIES = [
  "intent",
  "failure-mode",
  "timeout",
  "consistency",
  "idempotency",
  "retries",
  "events",
  "security",
  "data",
  "other"
];
function newChangeSet(args) {
  return {
    id: args.id,
    title: args.title,
    base: args.base,
    request: args.request,
    intent: "",
    flow: args.flow,
    ops: [],
    questions: [],
    status: "draft",
    risk: args.risk,
    createdAt: args.now,
    updatedAt: args.now,
    history: [{ at: args.now, event: "created", detail: args.request }]
  };
}
function slugify(text2) {
  return text2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "change";
}
function applyOps(model, ops) {
  const nodes = new Map(model.nodes.map((n) => [n.id, { ...n }]));
  const edges = new Map(model.edges.map((e) => [edgeId(e), { ...e }]));
  const annotations = [];
  const conflicts = [];
  const findEdge = (from, to) => [...edges.values()].find((e) => e.from === from && e.to === to && e.mark !== "removed");
  const needNode = (index, id) => {
    const n = nodes.get(id);
    if (!n || n.mark === "removed") {
      conflicts.push({ index, message: `no node "${id}" on the map` });
      return false;
    }
    return true;
  };
  ops.forEach((op, index) => {
    switch (op.op) {
      case "addNode": {
        if (nodes.has(op.id) && nodes.get(op.id).mark !== "removed") {
          conflicts.push({ index, message: `node "${op.id}" is already on the map` });
          return;
        }
        nodes.set(op.id, {
          id: op.id,
          label: op.label ?? op.id,
          kind: op.kind,
          external: op.external,
          detail: op.detail ?? (op.file ? `NEW \xB7 ${op.file}` : "NEW"),
          note: op.note,
          takes: op.takes,
          returns: op.returns,
          file: op.file,
          mark: "added"
        });
        return;
      }
      case "removeNode": {
        if (!needNode(index, op.id)) return;
        nodes.get(op.id).mark = "removed";
        for (const e of edges.values()) {
          if (e.from === op.id || e.to === op.id) e.mark = "removed";
        }
        return;
      }
      case "updateNode": {
        if (!needNode(index, op.id)) return;
        const n = nodes.get(op.id);
        Object.assign(n, {
          ...op.label !== void 0 && { label: op.label },
          ...op.file !== void 0 && { file: op.file },
          ...op.takes !== void 0 && { takes: op.takes },
          ...op.returns !== void 0 && { returns: op.returns },
          ...op.note !== void 0 && { note: op.note }
        });
        if (n.mark !== "added") n.mark = "modified";
        return;
      }
      case "addEdge":
      case "addBranch": {
        if (!needNode(index, op.from) || !needNode(index, op.to)) return;
        const existing = findEdge(op.from, op.to);
        if (existing && op.op === "addEdge") {
          conflicts.push({ index, message: `${op.from} \u2192 ${op.to} is already on the map` });
          return;
        }
        const when = op.op === "addBranch" ? op.when : void 0;
        const id = edges.has(`${op.from}->${op.to}`) || existing ? `${op.from}->${op.to}#${index}` : void 0;
        const edge = {
          ...id && { id },
          from: op.from,
          to: op.to,
          kind: op.op === "addBranch" ? "branch" : op.kind ?? "call",
          confidence: "read",
          when,
          label: op.op === "addEdge" ? op.label : when,
          note: op.op === "addEdge" ? op.note : void 0,
          mark: "added"
        };
        edges.set(edgeId(edge), edge);
        return;
      }
      case "removeEdge": {
        const e = findEdge(op.from, op.to);
        if (!e) {
          conflicts.push({ index, message: `no edge ${op.from} \u2192 ${op.to} on the map` });
          return;
        }
        if (e.mark === "added") edges.delete(edgeId(e));
        else e.mark = "removed";
        return;
      }
      case "rerouteEdge": {
        const e = findEdge(op.from, op.to);
        if (!e) {
          conflicts.push({ index, message: `no edge ${op.from} \u2192 ${op.to} to reroute` });
          return;
        }
        const from = op.newFrom ?? op.from;
        const to = op.newTo ?? op.to;
        if (!needNode(index, from) || !needNode(index, to)) return;
        if (e.mark === "added") {
          edges.delete(edgeId(e));
        } else {
          e.mark = "removed";
        }
        const next = {
          ...e,
          id: void 0,
          from,
          to,
          evidence: void 0,
          confidence: "read",
          mark: "added",
          was: `${op.from}->${op.to}`
        };
        const key = edgeId(next);
        if (edges.has(key)) next.id = `${key}#${index}`;
        edges.set(edgeId(next), next);
        return;
      }
      case "annotate": {
        annotations.push({ target: op.target, note: op.note });
        return;
      }
    }
  });
  return {
    ...model,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    annotations,
    conflicts
  };
}
function afterOnly(proposed) {
  const edges = proposed.edges.filter((e) => e.mark !== "removed").map(({ mark, was, ...e }) => e);
  const kept = new Set(edges.map(edgeId));
  return {
    version: 1,
    commit: proposed.commit,
    repo: proposed.repo,
    nodes: proposed.nodes.filter((n) => n.mark !== "removed").map(({ mark, takes, returns, file, ...n }) => n),
    edges,
    // A flow keeps the steps whose edges survive; the re-map writes the new path.
    flows: proposed.flows.map((f) => ({ ...f, steps: f.steps.filter((s) => kept.has(s.edge)) }))
  };
}
function describeOp(op, labels) {
  const l = (id) => labels?.get(id) ?? id;
  switch (op.op) {
    case "addNode":
      return { sign: "+", text: `New ${op.kind} ${op.label ?? op.id}` };
    case "removeNode":
      return { sign: "\u2212", text: `Remove ${l(op.id)}` };
    case "updateNode":
      return { sign: "~", text: `Change ${l(op.id)}` };
    case "addEdge":
      return { sign: "+", text: `${l(op.from)} \u2192 ${l(op.to)}` };
    case "removeEdge":
      return { sign: "\u2212", text: `${l(op.from)} \u2192 ${l(op.to)}` };
    case "rerouteEdge":
      return {
        sign: "~",
        text: `${l(op.newFrom ?? op.from)} \u2192 ${l(op.newTo ?? op.to)}, was ${l(op.from)} \u2192 ${l(op.to)}`
      };
    case "addBranch":
      return { sign: "+", text: `Branch ${op.when} \u2192 ${l(op.to)}` };
    case "annotate":
      return { sign: "\u2022", text: `Note on ${l(op.target)}: ${op.note}` };
  }
}
function touchedFiles(model, cs) {
  const { nodes } = indexModel(model);
  const files = /* @__PURE__ */ new Set();
  const add = (id) => {
    const n = nodes.get(id);
    if (n?.source?.file) files.add(n.source.file);
  };
  for (const op of cs.ops) {
    switch (op.op) {
      case "addNode":
        if (op.file) files.add(op.file);
        break;
      case "removeNode":
      case "updateNode":
        add(op.id);
        if (op.op === "updateNode" && op.file) files.add(op.file);
        break;
      case "addEdge":
      case "removeEdge":
      case "addBranch":
        add(op.from);
        break;
      case "rerouteEdge":
        add(op.from);
        add(op.newFrom ?? op.from);
        break;
      case "annotate":
        break;
    }
  }
  return [...files].sort();
}
function touchedNodes(cs) {
  const ids = /* @__PURE__ */ new Set();
  for (const op of cs.ops) {
    switch (op.op) {
      case "addNode":
      case "removeNode":
      case "updateNode":
        ids.add(op.id);
        break;
      case "addEdge":
      case "removeEdge":
      case "addBranch":
        ids.add(op.from);
        ids.add(op.to);
        break;
      case "rerouteEdge":
        ids.add(op.from);
        ids.add(op.to);
        if (op.newFrom) ids.add(op.newFrom);
        if (op.newTo) ids.add(op.newTo);
        break;
      case "annotate":
        break;
    }
  }
  return [...ids];
}
function openBlocking(cs) {
  return cs.questions.filter((q) => q.severity === "blocking" && q.status === "open");
}
function admitQuestions(existing, incoming) {
  const accepted = [];
  const dropped = [];
  const seen = new Set(existing.map((q) => normalise(q.question)));
  const ids = new Set(existing.map((q) => q.id));
  incoming.forEach((q, i) => {
    const id = q.id ?? `q${existing.length + accepted.length + 1}`;
    if (!q.question || q.question.trim().length < 10) {
      dropped.push({ id, reason: "the question is empty or too short to answer" });
      return;
    }
    if (!Array.isArray(q.evidence) || q.evidence.length === 0) {
      dropped.push({ id, reason: "no evidence: every question must cite the code that prompted it" });
      return;
    }
    if (q.evidence.some((e) => !e || typeof e.file !== "string" || !Number.isInteger(e.line))) {
      dropped.push({ id, reason: "each piece of evidence needs a file and a line" });
      return;
    }
    const key = normalise(q.question);
    if (seen.has(key)) {
      dropped.push({ id, reason: "repeats an earlier question" });
      return;
    }
    if (ids.has(id)) {
      dropped.push({ id, reason: `id "${id}" is taken` });
      return;
    }
    seen.add(key);
    ids.add(id);
    accepted.push({
      id,
      severity: q.severity === "blocking" ? "blocking" : "worth-checking",
      category: QUESTION_CATEGORIES.includes(q.category) ? q.category : "other",
      target: q.target ?? "",
      headline: q.headline,
      question: q.question.trim(),
      evidence: q.evidence,
      checked: q.checked,
      options: q.options,
      status: "open"
    });
    void i;
  });
  return { accepted, dropped };
}
function normalise(text2) {
  return text2.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
var fail = (reason) => ({ ok: false, reason });
var done = (value) => ({ ok: true, value });
function touch(cs, now, event, detail) {
  return { ...cs, updatedAt: now, history: [...cs.history, { at: now, event, ...detail && { detail } }] };
}
function setOps(cs, ops, now, by) {
  if (cs.status !== "draft" && cs.status !== "in-review") {
    return fail(`the change is ${cs.status}; the map can only change while it is a draft or in review`);
  }
  const stamped = ops.map((op) => ({ ...op, by: op.by ?? by }));
  return done(touch({ ...cs, ops: stamped }, now, "map-edited", `${ops.length} operation(s) by ${by}`));
}
function addTranscribedOps(cs, ops, now) {
  if (cs.status !== "draft" && cs.status !== "in-review") {
    return fail(`the change is ${cs.status}; the map can only change while it is a draft or in review`);
  }
  const stamped = ops.map((op) => ({ ...op, by: op.quote && op.quote.trim().length > 0 ? "engineer" : "claude" }));
  return done(touch({ ...cs, ops: [...cs.ops, ...stamped] }, now, "map-edited", `${ops.length} operation(s) transcribed`));
}
function acceptOp(cs, index, now) {
  const op = cs.ops[index];
  if (!op) return fail(`no operation ${index}`);
  const ops = cs.ops.map((o, i) => i === index ? { ...o, by: "engineer" } : o);
  return done(touch({ ...cs, ops }, now, "op-accepted", String(index)));
}
function suggestedOps(cs) {
  return cs.ops.flatMap((op, i) => op.by === "claude" ? [i] : []);
}
function setIntent(cs, intent, now) {
  return done(touch({ ...cs, intent }, now, "intent"));
}
function submit(cs, now) {
  if (cs.status !== "draft") return fail(`the change is already ${cs.status}`);
  if (cs.intent.trim().length < 10) {
    return fail("say what you are trying to do, in a sentence, before Claude reviews the change");
  }
  if (cs.ops.length === 0) return fail("draw the change on the map first: add, remove or reroute something");
  return done(touch({ ...cs, status: "in-review" }, now, "submitted"));
}
function addQuestions(cs, incoming, now) {
  if (cs.status !== "in-review") return fail(`questions are asked while the change is in review; it is ${cs.status}`);
  const check = admitQuestions(cs.questions, incoming);
  const next = touch({ ...cs, questions: [...cs.questions, ...check.accepted] }, now, "questions", `${check.accepted.length} asked, ${check.dropped.length} dropped`);
  return done({ cs: next, check });
}
function answerQuestion(cs, args, now) {
  if (cs.status !== "in-review") return fail(`answers are recorded while the change is in review; it is ${cs.status}`);
  const q = cs.questions.find((x) => x.id === args.questionId);
  if (!q) return fail(`no question "${args.questionId}"`);
  const option = args.optionId ? q.options?.find((o) => o.id === args.optionId) : void 0;
  if (args.optionId && !option) return fail(`question ${q.id} has no option "${args.optionId}"`);
  const text2 = args.text?.trim();
  if (!option && !text2) return fail("pick an option or answer in your own words");
  const mapOps = [...option?.ops ?? [], ...args.ops ?? []].map((op) => ({ ...op, by: "engineer" }));
  const answer = {
    ...option && { optionId: option.id },
    ...text2 && { text: text2 },
    at: now,
    changedMap: mapOps.length > 0,
    ...args.quote && { quote: args.quote }
  };
  const questions = cs.questions.map((x) => x.id === q.id ? { ...x, status: "answered", answer } : x);
  return done(touch({ ...cs, questions, ops: [...cs.ops, ...mapOps] }, now, "answered", q.id));
}
function rateQuestion(cs, questionId, rating, now) {
  const q = cs.questions.find((x) => x.id === questionId);
  if (!q) return fail(`no question "${questionId}"`);
  const questions = cs.questions.map((x) => x.id === questionId ? { ...x, rating } : x);
  return done(touch({ ...cs, questions }, now, "rated", `${questionId}:${rating}`));
}
function dismissQuestion(cs, questionId, now) {
  const q = cs.questions.find((x) => x.id === questionId);
  if (!q) return fail(`no question "${questionId}"`);
  if (q.severity === "blocking") return fail("a blocking question has to be answered, not dismissed");
  const questions = cs.questions.map((x) => x.id === questionId ? { ...x, status: "dismissed" } : x);
  return done(touch({ ...cs, questions }, now, "dismissed", questionId));
}
function approvalBlockers(cs) {
  const out = [];
  if (cs.status !== "in-review") out.push(`the change is ${cs.status}, not in review`);
  const open = openBlocking(cs);
  if (open.length > 0) {
    out.push(`answer ${open.length} more blocking question${open.length === 1 ? "" : "s"} first (${open.map((q) => q.id).join(", ")})`);
  }
  const suggested = suggestedOps(cs);
  if (suggested.length > 0) {
    out.push(`${suggested.length} operation(s) on the map were suggested by Claude; the engineer has to accept or remove them`);
  }
  if (cs.ops.length === 0) out.push("the map has no changes");
  return out;
}
function approve(cs, now, quote) {
  const blockers = approvalBlockers(cs);
  if (blockers.length > 0) return fail(blockers.join("; "));
  return done(touch({ ...cs, status: "approved" }, now, "approved", quote));
}
function checkPlan(cs, tasks) {
  const problems = [];
  const covered = /* @__PURE__ */ new Set();
  tasks.forEach((t, i) => {
    if (!t.title) problems.push(`task ${i + 1} needs a title`);
    if (!Array.isArray(t.ops) || t.ops.length === 0) {
      problems.push(`task "${t.title || i + 1}" builds nothing on the map; work that isn't on the map isn't planned`);
      return;
    }
    for (const n of t.ops) {
      const op = cs.ops[n];
      if (!op) problems.push(`task "${t.title}" names operation ${n}, which the change set doesn't have`);
      else covered.add(n);
    }
  });
  cs.ops.forEach((op, i) => {
    if (op.op !== "annotate" && !covered.has(i)) {
      problems.push(`operation ${i} (${describeOp(op).text}) has no task`);
    }
  });
  return problems;
}
function savePlan(cs, tasks, now) {
  if (cs.status !== "approved" && cs.status !== "implemented") {
    return fail(`a plan is made from an approved change; this one is ${cs.status}`);
  }
  const problems = checkPlan(cs, tasks);
  if (problems.length > 0) return fail(problems.join("; "));
  return done(touch({ ...cs, plan: tasks }, now, "planned", `${tasks.length} task(s)`));
}
function markImplemented(cs, now) {
  if (cs.status !== "approved") return fail(`only an approved change can be marked implemented; this one is ${cs.status}`);
  return done(touch({ ...cs, status: "implemented" }, now, "implemented"));
}
function recordDrift(cs, drift, now) {
  if (cs.status !== "implemented" && cs.status !== "approved" && cs.status !== "verified") {
    return fail(`verify runs on an implemented change; this one is ${cs.status}`);
  }
  const status = drift.ok ? "verified" : "implemented";
  return done(touch({ ...cs, drift, status }, now, drift.ok ? "verified" : "drift", drift.ok ? void 0 : `${drift.missing.length + drift.unexpected.length + drift.stillPresent.length + drift.missingNodes.length} difference(s)`));
}
function skip(cs, reason, now) {
  if (reason.trim().length < 5) return fail("give a reason for skipping; it is logged");
  return done(touch({ ...cs, status: "skipped", skipReason: reason.trim() }, now, "skipped", reason.trim()));
}

// plugins/sysedit/core/drift.ts
var pair = (e) => `${e.from}->${e.to}`;
function checkDrift(base, cs, actual, now) {
  const approved = afterOnly(applyOps(base, cs.ops));
  const scope = new Set(touchedNodes(cs));
  const inScope = (e) => scope.has(e.from) || scope.has(e.to);
  const approvedPairs = new Set(approved.edges.map(pair));
  const actualPairs = new Set(actual.edges.map(pair));
  const actualNodes = new Set(actual.nodes.map((n) => n.id));
  const missing = approved.edges.filter((e) => inScope(e) && !actualPairs.has(pair(e))).map(pair);
  const unexpected = actual.edges.filter((e) => inScope(e) && !approvedPairs.has(pair(e))).map(pair);
  const stillPresent = [];
  for (const op of cs.ops) {
    if (op.op === "removeEdge" && actualPairs.has(`${op.from}->${op.to}`) && !approvedPairs.has(`${op.from}->${op.to}`)) {
      stillPresent.push(`${op.from}->${op.to}`);
    }
    if (op.op === "rerouteEdge") {
      const old = `${op.from}->${op.to}`;
      if (actualPairs.has(old) && !approvedPairs.has(old)) stillPresent.push(old);
    }
  }
  const missingNodes = cs.ops.flatMap((op) => op.op === "addNode" && !actualNodes.has(op.id) ? [op.id] : []);
  const dedupe = (xs) => [...new Set(xs)];
  const report = {
    ok: false,
    checkedAt: now,
    commit: actual.commit,
    missing: dedupe(missing.filter((m) => !stillPresent.includes(m))),
    unexpected: dedupe(unexpected.filter((u) => !stillPresent.includes(u))),
    stillPresent: dedupe(stillPresent),
    missingNodes: dedupe(missingNodes)
  };
  report.ok = report.missing.length === 0 && report.unexpected.length === 0 && report.stillPresent.length === 0 && report.missingNodes.length === 0;
  return report;
}
function formatDrift(report) {
  if (report.ok) return "No drift: the code matches the approved map.";
  const lines = ["Drift between the approved map and the code:"];
  for (const e of report.missingNodes) lines.push(`  missing node      ${e}  (drawn, not built)`);
  for (const e of report.missing) lines.push(`  missing edge      ${e}  (drawn, not in the code)`);
  for (const e of report.stillPresent) lines.push(`  still present     ${e}  (removed on the map, still in the code)`);
  for (const e of report.unexpected) lines.push(`  unexpected edge   ${e}  (in the code, not drawn)`);
  return lines.join("\n");
}

// plugins/sysedit/core/gate.ts
var STAGE_LABEL = {
  idle: "No change in progress",
  map: "Mapping",
  edit: "Drawing the change",
  grill: "Answering Claude\u2019s questions",
  implement: "Approved: building",
  verify: "Built: verifying against the map",
  done: "Verified",
  skipped: "Skipped"
};
function stageOf(cs, hasModel = true) {
  if (!cs) return "idle";
  switch (cs.status) {
    case "draft":
      return hasModel ? "edit" : "map";
    case "in-review":
      return "grill";
    case "approved":
      return "implement";
    case "implemented":
      return "verify";
    case "verified":
      return "done";
    case "skipped":
      return "skipped";
  }
}
var WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
var ALWAYS_OPEN = [/^\.sysedit\//, /^docs\/adr\//];
var SUPPORTING = [/(^|\/)(__tests__|tests?|spec|e2e)\//, /\.(test|spec)\.[a-z]+$/, /(^|\/)CHANGELOG\.md$/i];
function normalisePath(p) {
  const parts = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (p.startsWith("/") ? "/" : "") + parts.join("/");
}
function relativeToRoot(filePath, root, cwd = root) {
  const abs = normalisePath(filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`);
  const base = normalisePath(root);
  if (abs === base) return "";
  if (!abs.startsWith(base.endsWith("/") ? base : `${base}/`)) return null;
  return abs.slice(base.length + (base.endsWith("/") ? 0 : 1));
}
function decide(input) {
  if (!WRITE_TOOLS.includes(input.tool)) return { allow: true, why: "not a write" };
  if (input.mode === "off") return { allow: true, why: "gate is off" };
  if (!input.filePath) return { allow: true, why: "no path" };
  const rel = relativeToRoot(input.filePath, input.root, input.cwd);
  if (rel === null) return { allow: true, why: "outside the project" };
  if (ALWAYS_OPEN.some((re) => re.test(rel))) return { allow: true, why: "sysedit\u2019s own files" };
  const cs = input.change;
  if (!cs) return { allow: true, why: "no change in progress" };
  switch (cs.status) {
    case "skipped":
      return { allow: true, why: "process skipped, reason logged" };
    case "verified":
      return { allow: true, why: "change verified" };
    case "draft":
      return {
        allow: false,
        reason: `System Editor is holding writes to ${rel}: change "${cs.title}" is still being drawn. ` + (cs.ops.length === 0 ? "Ask the engineer to draw the change on the map (/sysedit:map opens the editor). If they have already described it in their own words, transcribe that onto the map with propose_ops, quoting them, and show it back; " : "Ask the engineer to finish the map and submit it for review; ") + "or they can run /sysedit:skip with a reason if this change is too small for the process. Do not write code yet."
      };
    case "in-review": {
      const blockers = approvalBlockers(cs);
      const open = openBlocking(cs);
      const suggested = suggestedOps(cs);
      return {
        allow: false,
        reason: `System Editor is holding writes to ${rel}: change "${cs.title}" is in review and not approved. ` + (open.length > 0 ? `The engineer has ${open.length} blocking question${open.length === 1 ? "" : "s"} to answer (${open.map((q) => q.id).join(", ")}). ` : suggested.length > 0 ? `${suggested.length} operation(s) you suggested still need the engineer's acceptance. ` : `It still needs: ${blockers.join("; ")}. `) + "Do not answer the questions yourself; ask the engineer, record their answers, then approve."
      };
    }
    case "approved":
    case "implemented": {
      if (input.mode !== "strict" || !input.model) return { allow: true, why: "change approved" };
      const files = touchedFiles(input.model, cs);
      if (files.includes(rel) || SUPPORTING.some((re) => re.test(rel))) return { allow: true, why: "on the approved map" };
      if (cs.plan?.some((t) => t.files.includes(rel))) return { allow: true, why: "in the approved plan" };
      return {
        allow: false,
        reason: `System Editor (strict) is holding writes to ${rel}: it isn't on the approved map for "${cs.title}". The map covers ${files.length > 0 ? files.join(", ") : "no files yet"}. Ask the engineer whether this file belongs to the change; if so, they add it to the map, or name it in the plan.`
      };
    }
  }
}

// plugins/sysedit/core/mermaid.ts
var safeId = (id) => id.replace(/[^A-Za-z0-9_]/g, "_");
var text = (s) => s.replace(/"/g, "#quot;").replace(/[<>]/g, "");
function toMermaid(model, opts = {}) {
  const m = opts.flow ? flowSlice(model, opts.flow) : model;
  const lines = [];
  if (opts.title) lines.push("---", `title: ${text(opts.title)}`, "---");
  lines.push("flowchart TD");
  for (const n of m.nodes) {
    const label = n.detail ? `${text(n.label)}<br/><small>${text(n.detail)}</small>` : text(n.label);
    const shape = n.external || n.kind === "external" ? [`([`, `])`] : n.kind === "datastore" ? ["[(", ")]"] : n.kind === "topic" ? ["[/", "/]"] : ["[", "]"];
    lines.push(`  ${safeId(n.id)}${shape[0]}"${label}"${shape[1]}`);
  }
  const classes = { added: [], removed: [], modified: [] };
  const linkStyles = [];
  m.edges.forEach((e, i) => {
    const label = e.when ?? e.label;
    const arrow = e.confidence === "inferred" ? "-.->" : "-->";
    lines.push(`  ${safeId(e.from)} ${arrow}${label ? `|"${text(label)}"|` : ""} ${safeId(e.to)}`);
    const mark = e.mark;
    if (mark === "added") linkStyles.push(`  linkStyle ${i} stroke:#1D7347,stroke-width:2px`);
    if (mark === "removed") linkStyles.push(`  linkStyle ${i} stroke:#B42318,stroke-width:2px,stroke-dasharray:4 4`);
    if (e.confidence === "inferred" && !mark) linkStyles.push(`  linkStyle ${i} stroke:#B26B00`);
  });
  for (const n of m.nodes) {
    const mark = n.mark;
    if (mark && classes[mark]) classes[mark].push(safeId(n.id));
  }
  lines.push(...linkStyles);
  lines.push("  classDef added fill:#E7F3EC,stroke:#1D7347,stroke-width:2px");
  lines.push("  classDef removed fill:#FBE9E7,stroke:#B42318,stroke-dasharray:4 4");
  lines.push("  classDef modified fill:#FBF0DE,stroke:#8F5400");
  for (const [name, ids] of Object.entries(classes)) {
    if (ids.length > 0) lines.push(`  class ${ids.join(",")} ${name}`);
  }
  return lines.join("\n");
}

// plugins/sysedit/core/metrics.ts
var minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 6e4;
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
var ratio = (num, den) => den === 0 ? null : num / den;
function computeMetrics(changes, skips, explains) {
  const byStatus = {};
  const toSubmit = [];
  const inReview = [];
  let blockingAsked = 0;
  let blockingAnswered = 0;
  let changedMap = 0;
  let rated = 0;
  let useful = 0;
  let verified = 0;
  let drifted = 0;
  for (const cs of changes) {
    byStatus[cs.status] = (byStatus[cs.status] ?? 0) + 1;
    const at = (event) => cs.history.find((h) => h.event === event)?.at;
    const submitted = at("submitted");
    const approved = at("approved");
    if (submitted) toSubmit.push(minutes(cs.createdAt, submitted));
    if (submitted && approved) inReview.push(minutes(submitted, approved));
    for (const q of cs.questions) {
      if (q.severity === "blocking") {
        blockingAsked += 1;
        if (q.status === "answered") {
          blockingAnswered += 1;
          if (q.answer?.changedMap) changedMap += 1;
        }
      }
      if (q.rating) {
        rated += 1;
        if (q.rating === "useful") useful += 1;
      }
    }
    const verifiedOnce = cs.history.some((h) => h.event === "verified");
    const driftOnce = cs.history.some((h) => h.event === "drift");
    if (verifiedOnce || driftOnce) {
      verified += 1;
      if (driftOnce) drifted += 1;
    }
  }
  const skippedChanges = changes.filter((c) => c.status === "skipped").length;
  const looseSkips = skips.filter((s) => !s.change || !changes.some((c) => c.id === s.change)).length;
  const totalSkips = skippedChanges + looseSkips;
  return {
    changes: changes.length,
    byStatus,
    medianMinutesToSubmit: median(toSubmit),
    medianMinutesInReview: median(inReview),
    blockingAsked,
    grillHitRate: ratio(changedMap, blockingAnswered),
    usefulRate: ratio(useful, rated),
    driftCaughtRate: ratio(drifted, verified),
    skips: totalSkips,
    skipRate: ratio(totalSkips, changes.length + looseSkips),
    explainBackMean: explains.length === 0 ? null : explains.reduce((a, e) => a + e.score, 0) / explains.length,
    explainBackCount: explains.length
  };
}
function formatMetrics(m) {
  const pct = (x) => x === null ? "\u2014" : `${Math.round(x * 100)}%`;
  const mins = (x) => x === null ? "\u2014" : `${x.toFixed(1)} min`;
  return [
    `Changes: ${m.changes} (${Object.entries(m.byStatus).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`,
    `Time to submit a drawn change (median): ${mins(m.medianMinutesToSubmit)}`,
    `Time defending it in review (median): ${mins(m.medianMinutesInReview)}`,
    `Grill hit rate (blocking answers that changed the map): ${pct(m.grillHitRate)} of ${m.blockingAsked} blocking asked`,
    `Questions rated useful: ${pct(m.usefulRate)}`,
    `Drift caught before merge: ${pct(m.driftCaughtRate)}`,
    `Skips: ${m.skips} (skip rate ${pct(m.skipRate)})`,
    `Explain-back mean score: ${pct(m.explainBackMean)} over ${m.explainBackCount} check(s)`
  ].join("\n");
}

// plugins/sysedit/core/risk.ts
var HIGH = [
  /\b(payment|charge|capture|refund|billing|invoice|money|price|pricing)\b/i,
  /\b(auth|login|password|token|session|permission|role|acl|oauth|secret)\b/i,
  /\b(migrat\w*|schema|drop|delete|purge|backfill)\b/i,
  /\b(checkout|order|inventory|stock)\b/i,
  /\b(queue|event|webhook|retry|idempoten\w*|transaction|outbox|cache)\b/i,
  /\b(concurren\w*|race|lock|timeout)\b/i
];
var LOW = [
  /\b(typo|spelling|comment|docs?|readme|changelog|wording|copy text|lint|format(ting)?)\b/i,
  /\b(rename|bump|upgrade (a|the) dev ?dependency|log (line|message))\b/i,
  /\b(test name|snapshot)\b/i
];
function guessRisk(request, opCount = 0) {
  const high = HIGH.find((re) => re.test(request));
  if (high || opCount >= 6) {
    return { risk: "high", why: high ? `the request touches ${request.match(high)[0]}` : `${opCount} operations on the map` };
  }
  const low = LOW.find((re) => re.test(request));
  if (low && opCount <= 1) return { risk: "low", why: `looks like a ${request.match(low)[0]} change` };
  return { risk: "medium", why: "a code change with no obvious hot spot" };
}

// plugins/sysedit/core/validate.ts
function isSafeRelativePath(file) {
  if (!file || file.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(file)) return false;
  return !file.split(/[\\/]/).some((part) => part === "..");
}
function validateModel(model, facts) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  if (!model || typeof model !== "object") {
    err("", "the model must be a JSON object");
    return { ok: false, errors, warnings };
  }
  const m = model;
  if (m.version !== 1) err("version", "must be 1");
  if (typeof m.commit !== "string" || m.commit.length === 0) err("commit", "must name the commit the model was read from");
  for (const key of ["nodes", "edges", "flows"]) {
    if (!Array.isArray(m[key])) err(key, "must be an array");
  }
  if (errors.length > 0) return { ok: false, errors, warnings };
  const checkFile = (path, file, first, last) => {
    if (!isSafeRelativePath(file)) {
      err(path, `"${file}" must be a path relative to the repository root, without ".."`);
      return;
    }
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
      err(path, `line range ${first}\u2013${last} is not a valid 1-based range`);
      return;
    }
    if (facts) {
      const count = facts.lineCounts.get(file);
      if (count === void 0) err(path, `${file} does not exist in the repository`);
      else if (last > count) err(path, `${file} has ${count} lines, so ${first}\u2013${last} is out of range`);
    }
  };
  const nodeIds = /* @__PURE__ */ new Set();
  m.nodes.forEach((n, i) => {
    const p = `nodes[${i}]`;
    if (!n || typeof n.id !== "string" || n.id.length === 0) {
      err(p, "needs an id");
      return;
    }
    if (nodeIds.has(n.id)) err(p, `duplicate node id "${n.id}"`);
    nodeIds.add(n.id);
    if (typeof n.label !== "string" || n.label.length === 0) err(p, `node "${n.id}" needs a label`);
    if (!NODE_KINDS.includes(n.kind)) err(p, `node "${n.id}" has unknown kind "${String(n.kind)}"`);
    if (n.external || n.kind === "external") {
      if (n.source) checkFile(`${p}.source`, n.source.file, n.source.lines?.[0], n.source.lines?.[1]);
    } else if (!n.source) {
      err(p, `node "${n.id}" has no source: every box needs the file and lines it came from (mark it external if it lives outside the repo)`);
    } else {
      checkFile(`${p}.source`, n.source.file, n.source.lines?.[0], n.source.lines?.[1]);
    }
  });
  m.nodes.forEach((n, i) => {
    if (n?.parent && !nodeIds.has(n.parent)) err(`nodes[${i}].parent`, `parent "${n.parent}" is not a node`);
  });
  const edgeIds = /* @__PURE__ */ new Set();
  m.edges.forEach((e, i) => {
    const p = `edges[${i}]`;
    if (!e || typeof e.from !== "string" || typeof e.to !== "string") {
      err(p, "needs from and to");
      return;
    }
    const id = edgeId(e);
    if (edgeIds.has(id)) err(p, `duplicate edge "${id}"; give one of them an explicit id`);
    edgeIds.add(id);
    if (!nodeIds.has(e.from)) err(p, `edge "${id}" starts at unknown node "${e.from}"`);
    if (!nodeIds.has(e.to)) err(p, `edge "${id}" ends at unknown node "${e.to}"`);
    if (!EDGE_KINDS.includes(e.kind)) err(p, `edge "${id}" has unknown kind "${String(e.kind)}"`);
    if (e.confidence !== "read" && e.confidence !== "inferred") {
      err(p, `edge "${id}" must say whether it was read from code or inferred`);
    } else if (e.confidence === "read" && !e.evidence) {
      err(p, `edge "${id}" is marked read but has no evidence: give the file and line, or mark it inferred`);
    } else if (e.confidence === "inferred" && !e.note) {
      warn(p, `inferred edge "${id}" should say how it was inferred, so the engineer knows what to check`);
    }
    if (e.evidence) checkFile(`${p}.evidence`, e.evidence.file, e.evidence.line, e.evidence.endLine ?? e.evidence.line);
  });
  const flowIds = /* @__PURE__ */ new Set();
  m.flows.forEach((f, i) => {
    const p = `flows[${i}]`;
    if (!f || typeof f.id !== "string") {
      err(p, "needs an id");
      return;
    }
    if (flowIds.has(f.id)) err(p, `duplicate flow id "${f.id}"`);
    flowIds.add(f.id);
    if (!f.entry) err(p, `flow "${f.id}" needs an entry, such as "POST /checkout"`);
    if (!nodeIds.has(f.entryNode)) err(p, `flow "${f.id}" starts at unknown node "${f.entryNode}"`);
    if (!Array.isArray(f.steps) || f.steps.length === 0) {
      err(p, `flow "${f.id}" has no steps`);
      return;
    }
    const visited = /* @__PURE__ */ new Set([f.entryNode]);
    f.steps.forEach((s, j) => {
      const edge = m.edges.find((e) => edgeId(e) === s.edge);
      if (!edge) {
        err(`${p}.steps[${j}]`, `step walks unknown edge "${s.edge}"`);
        return;
      }
      if (!s.title) warn(`${p}.steps[${j}]`, "step needs a title the engineer can read");
      if (!visited.has(edge.from)) {
        warn(`${p}.steps[${j}]`, `step starts at "${edge.from}", which no earlier step reached`);
      }
      visited.add(edge.from);
      visited.add(edge.to);
    });
  });
  return { ok: errors.length === 0, errors, warnings };
}
function formatReport(report) {
  const lines = [report.ok ? "Model is valid." : `Model has ${report.errors.length} error(s).`];
  for (const e of report.errors) lines.push(`  error   ${e.path || "(root)"}: ${e.message}`);
  for (const w of report.warnings) lines.push(`  warning ${w.path || "(root)"}: ${w.message}`);
  return lines.join("\n");
}

// src/node/store.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
var DIR = ".sysedit";
function resolveRoot(explicit) {
  const root = explicit ?? process.env.SYSEDIT_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return resolve(root);
}
var Store = class {
  root;
  dir;
  constructor(root) {
    this.root = resolveRoot(root);
    this.dir = join(this.root, DIR);
  }
  path(...parts) {
    return join(this.dir, ...parts);
  }
  readJson(file) {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  }
  /** Write via a temporary file and a rename, so a reader never sees half a file. */
  writeJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, file);
  }
  // --- model -------------------------------------------------------------
  readModel() {
    return this.readJson(this.path("model.json"));
  }
  writeModel(model) {
    this.writeJson(this.path("model.json"), model);
    if (model.commit && /^[0-9a-f]{4,40}$/i.test(model.commit)) {
      this.writeJson(this.path("cache", `${model.commit}.json`), model);
    }
  }
  readCachedModel(commit) {
    if (!/^[0-9a-f]{4,40}$/i.test(commit)) return null;
    return this.readJson(this.path("cache", `${commit}.json`));
  }
  // --- change sets -------------------------------------------------------
  readState() {
    return this.readJson(this.path("state.json")) ?? { activeChange: null };
  }
  writeState(patch) {
    const next = { ...this.readState(), ...patch, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.writeJson(this.path("state.json"), next);
    return next;
  }
  listChanges() {
    const dir = this.path("changes");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => this.readJson(join(dir, f))).filter(Boolean);
  }
  readChange(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    return this.readJson(this.path("changes", `${id}.json`));
  }
  writeChange(cs) {
    if (!/^[A-Za-z0-9_-]+$/.test(cs.id)) throw new Error(`bad change id "${cs.id}"`);
    this.writeJson(this.path("changes", `${cs.id}.json`), cs);
  }
  activeChange() {
    const { activeChange } = this.readState();
    return activeChange ? this.readChange(activeChange) : null;
  }
  nextChangeNumber() {
    const nums = this.listChanges().map((c) => Number.parseInt(c.id, 10)).filter((n) => Number.isFinite(n));
    return (nums.length ? Math.max(...nums) : 0) + 1;
  }
  // --- logs --------------------------------------------------------------
  readJsonl(file) {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  appendJsonl(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(value) + "\n");
  }
  readSkips() {
    return this.readJsonl(this.path("skips.jsonl"));
  }
  logSkip(entry) {
    this.appendJsonl(this.path("skips.jsonl"), entry);
  }
  readExplainBacks() {
    return this.readJsonl(this.path("explain-back.jsonl"));
  }
  logExplainBack(entry) {
    this.appendJsonl(this.path("explain-back.jsonl"), entry);
  }
  // --- the repository ------------------------------------------------------
  headCommit() {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: this.root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "workdir";
    }
  }
  repoName() {
    try {
      const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: this.root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      const m = url.match(/([^/:]+\/[^/]+?)(\.git)?$/);
      if (m) return m[1];
    } catch {
    }
    return this.root.split(sep).pop() ?? "repo";
  }
  branch() {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return void 0;
    }
  }
  /** Files changed since `commit`, for an incremental re-map. */
  changedSince(commit) {
    try {
      return execFileSync("git", ["diff", "--name-only", commit, "--"], { cwd: this.root, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
  /**
   * Resolve a repository-relative path, refusing anything that lands outside
   * the root, through `..` or a symbolic link.
   */
  safeResolve(file) {
    if (!file || file.includes("\0")) return null;
    const abs = resolve(this.root, file);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || rel === "" || resolve(rel) === rel) return null;
    if (!existsSync(abs)) return null;
    try {
      const real = realpathSync(abs);
      const realRoot = realpathSync(this.root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
      if (!statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }
  /** Lines `start` to `end` of a file, 1-based and inclusive. */
  readLines(file, start, end) {
    const abs = this.safeResolve(file);
    if (!abs) return null;
    const all = readFileSync(abs, "utf8").split("\n");
    const s = Math.max(1, Math.floor(start));
    const e = Math.min(all.length, Math.max(s, Math.floor(end)), s + 400);
    return { file, start: s, lines: all.slice(s - 1, e), total: all.length };
  }
  /** Line counts for every file a model names, for validation. */
  fileFacts(model) {
    const files = /* @__PURE__ */ new Set();
    for (const n of model.nodes) if (n.source?.file) files.add(n.source.file);
    for (const e of model.edges) if (e.evidence?.file) files.add(e.evidence.file);
    const lineCounts = /* @__PURE__ */ new Map();
    for (const f of files) {
      const abs = this.safeResolve(f);
      if (abs) lineCounts.set(f, readFileSync(abs, "utf8").split("\n").length);
    }
    return { lineCounts };
  }
  adrDir() {
    return join(this.root, "docs", "adr");
  }
  nextAdrNumber() {
    const dir = this.adrDir();
    if (!existsSync(dir)) return 1;
    const nums = readdirSync(dir).map((f) => Number.parseInt(f, 10)).filter((n) => Number.isFinite(n));
    return (nums.length ? Math.max(...nums) : 0) + 1;
  }
};

// src/node/service.ts
var SyseditError = class extends Error {
};
function unwrap(r) {
  if (!r.ok) throw new SyseditError(r.reason);
  return r.value;
}
var Sysedit = class extends EventEmitter {
  store;
  clock;
  constructor(root, clock = () => /* @__PURE__ */ new Date()) {
    super();
    this.store = new Store(root);
    this.clock = clock;
  }
  now() {
    return this.clock().toISOString();
  }
  changed(what) {
    this.emit("changed", what);
  }
  // --- status ------------------------------------------------------------
  status() {
    const model = this.store.readModel();
    const cs = this.store.activeChange();
    const stage = stageOf(cs, !!model);
    const state2 = this.store.readState();
    return {
      root: this.store.root,
      repo: this.store.repoName(),
      head: this.store.headCommit(),
      stage,
      stageLabel: STAGE_LABEL[stage],
      model: model ? { commit: model.commit, ...modelStats(model), stale: model.commit !== this.store.headCommit() } : null,
      change: cs ? {
        id: cs.id,
        title: cs.title,
        status: cs.status,
        risk: cs.risk,
        ops: cs.ops.length,
        suggestedOps: suggestedOps(cs).length,
        openBlocking: openBlocking(cs).map((q) => ({ id: q.id, target: q.target, question: q.question })),
        questions: cs.questions.length,
        blockers: cs.status === "in-review" ? approvalBlockers(cs) : []
      } : null,
      editorUrl: state2.editorUrl
    };
  }
  /** Everything an editor needs to draw: status, the model, and the active change with its proposed model. */
  editorState() {
    const status = this.status();
    const model = this.store.readModel();
    let change = null;
    try {
      change = status.change ? this.getChange() : null;
    } catch {
      change = null;
    }
    return { status, model, change };
  }
  // --- the model -----------------------------------------------------------
  saveModel(model, opts = {}) {
    const existing = this.store.readModel();
    const next = opts.merge && existing ? mergeModels(existing, model) : model;
    next.generatedAt ??= this.now();
    next.repo ??= this.store.repoName();
    const report = validateModel(next, this.store.fileFacts(next));
    if (!report.ok) return { report, stats: modelStats(next) };
    this.store.writeModel(next);
    this.changed("model");
    return { report, stats: modelStats(next) };
  }
  validate(model) {
    const m = model ?? this.store.readModel();
    if (!m) return { ok: false, errors: [{ path: "", message: "no model yet: run /sysedit:map" }], warnings: [] };
    return validateModel(m, this.store.fileFacts(m));
  }
  getModel(opts = {}) {
    let model = this.store.readModel();
    if (!model) throw new SyseditError("no model yet: run /sysedit:map first");
    if (opts.flow) model = flowSlice(model, opts.flow);
    if (opts.level) model = atLevel(model, opts.level);
    return model;
  }
  // --- change sets ---------------------------------------------------------
  startChange(args) {
    const active = this.store.activeChange();
    if (active && !["verified", "skipped"].includes(active.status)) {
      throw new SyseditError(
        `change "${active.title}" (${active.id}) is still ${active.status}; finish it, or skip it with a reason, before starting another`
      );
    }
    const model = this.store.readModel();
    const n = String(this.store.nextChangeNumber()).padStart(4, "0");
    const id = `${n}-${slugify(args.title)}`;
    const cs = newChangeSet({
      id,
      title: args.title,
      base: model?.commit ?? this.store.headCommit(),
      request: args.request,
      flow: args.flow,
      risk: args.risk ?? guessRisk(args.request).risk,
      now: this.now()
    });
    this.store.writeChange(cs);
    this.store.writeState({ activeChange: id });
    this.changed("change");
    return cs;
  }
  requireActive(id) {
    const cs = id ? this.store.readChange(id) : this.store.activeChange();
    if (!cs) throw new SyseditError(id ? `no change "${id}"` : "no change in progress: start one with /sysedit:map");
    return cs;
  }
  save(cs) {
    this.store.writeChange(cs);
    this.changed("change");
    return cs;
  }
  getChange(id) {
    const cs = this.requireActive(id);
    const model = this.store.readModel() ?? emptyModel(cs.base);
    const proposed = applyOps(model, cs.ops);
    return {
      change: cs,
      stage: stageOf(cs, true),
      proposed,
      files: touchedFiles(model, cs),
      blockers: approvalBlockers(cs),
      suggestedOps: suggestedOps(cs)
    };
  }
  /** Ops from the editor: the engineer drew them. */
  setOps(ops, by = "engineer", intent) {
    let cs = unwrap(setOps(this.requireActive(), ops, this.now(), by));
    if (intent !== void 0) cs = unwrap(setIntent(cs, intent, this.now()));
    return this.save(cs);
  }
  /** Ops from Claude: suggestions unless they quote the engineer's own words. */
  transcribeOps(ops) {
    return this.save(unwrap(addTranscribedOps(this.requireActive(), ops, this.now())));
  }
  acceptOp(index) {
    return this.save(unwrap(acceptOp(this.requireActive(), index, this.now())));
  }
  removeOp(index) {
    const cs = this.requireActive();
    if (!cs.ops[index]) throw new SyseditError(`no operation ${index}`);
    return this.save(unwrap(setOps(cs, cs.ops.filter((_, i) => i !== index), this.now(), "engineer")));
  }
  setIntent(intent) {
    return this.save(unwrap(setIntent(this.requireActive(), intent, this.now())));
  }
  submit() {
    return this.save(unwrap(submit(this.requireActive(), this.now())));
  }
  addQuestions(questions) {
    const { cs, check } = unwrap(addQuestions(this.requireActive(), questions, this.now()));
    this.save(cs);
    return { accepted: check.accepted.map((q) => q.id), dropped: check.dropped, openBlocking: openBlocking(cs).length };
  }
  answer(args) {
    return this.save(unwrap(answerQuestion(this.requireActive(), args, this.now())));
  }
  rate(questionId, rating) {
    return this.save(unwrap(rateQuestion(this.requireActive(), questionId, rating, this.now())));
  }
  dismiss(questionId) {
    return this.save(unwrap(dismissQuestion(this.requireActive(), questionId, this.now())));
  }
  approve(quote) {
    return this.save(unwrap(approve(this.requireActive(), this.now(), quote)));
  }
  savePlan(tasks) {
    return this.save(unwrap(savePlan(this.requireActive(), tasks, this.now())));
  }
  markImplemented() {
    return this.save(unwrap(markImplemented(this.requireActive(), this.now())));
  }
  setAdr(path) {
    const cs = this.requireActive();
    return this.save({ ...cs, adr: path, updatedAt: this.now() });
  }
  /**
   * Compare a re-mapped model with the approved map. `actual` defaults to the
   * current model.json, which the verify skill refreshes before calling this.
   */
  verify(actual) {
    const cs = this.requireActive();
    const base = this.store.readCachedModel(cs.base) ?? this.store.readModel();
    if (!base) throw new SyseditError("no base model to compare against");
    const current = actual ?? this.store.readModel();
    if (!current) throw new SyseditError("no re-mapped model: map the changed code first");
    if (actual) {
      const report = validateModel(actual, this.store.fileFacts(actual));
      if (!report.ok) throw new SyseditError(`the re-mapped model is invalid: ${report.errors.map((e) => e.message).join("; ")}`);
    }
    const drift = checkDrift(base, cs, current, this.now());
    const next = unwrap(recordDrift(cs.status === "approved" ? unwrap(markImplemented(cs, this.now())) : cs, drift, this.now()));
    this.save(next);
    return drift;
  }
  skip(reason, opts = {}) {
    let cs = this.store.activeChange();
    const now = this.now();
    if (!cs || ["verified", "skipped"].includes(cs.status)) {
      this.store.logSkip({ at: now, reason, risk: guessRisk(opts.title ?? reason).risk });
      this.changed("skip");
      return { change: null, logged: true };
    }
    cs = this.save(unwrap(skip(cs, reason, now)));
    this.store.logSkip({ at: now, reason, change: cs.id, risk: cs.risk });
    return { change: cs, logged: true };
  }
  closeChange() {
    this.store.writeState({ activeChange: null });
    this.changed("change");
  }
  explainBack(entry) {
    const score = Math.max(0, Math.min(1, entry.score));
    const record = { ...entry, score, at: this.now() };
    this.store.logExplainBack(record);
    return record;
  }
  metrics() {
    return computeMetrics(this.store.listChanges(), this.store.readSkips(), this.store.readExplainBacks());
  }
  mermaid(opts = {}) {
    const model = this.store.readModel();
    if (!model) throw new SyseditError("no model yet: run /sysedit:map first");
    if (opts.proposed) {
      const cs = this.requireActive();
      return toMermaid(applyOps(model, cs.ops), { title: cs.title });
    }
    return toMermaid(model, { flow: opts.flow });
  }
};

// src/cli/main.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/http/server.ts
import { randomBytes } from "node:crypto";
import { existsSync as existsSync2, readFileSync as readFileSync2, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname as dirname2, extname, join as join2, normalize } from "node:path";
import { fileURLToPath } from "node:url";
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json"
};
function defaultEditorDir() {
  const here = dirname2(fileURLToPath(import.meta.url));
  const candidates = [join2(here, "editor"), join2(here, "..", "..", "plugins", "sysedit", "dist", "editor")];
  return candidates.find((d) => existsSync2(join2(d, "index.html"))) ?? candidates[0];
}
async function startEditorServer(app2, opts = {}) {
  const token = opts.token ?? randomBytes(16).toString("hex");
  const editorDir = opts.editorDir ?? defaultEditorDir();
  const clients = /* @__PURE__ */ new Set();
  const push = (what) => {
    for (const res of clients) res.write(`event: changed
data: ${JSON.stringify({ what })}

`);
  };
  app2.on("changed", push);
  let watcher;
  let debounce;
  try {
    watcher = watch(app2.store.dir, { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => push("disk"), 120);
    });
  } catch {
  }
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      const status = error instanceof SyseditError ? 409 : error instanceof HttpError ? error.status : 500;
      send(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
    status;
  }
  const send = (res, status, body) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new HttpError(413, "body too large");
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "body is not JSON");
    }
  };
  const localHost = (host) => !!host && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  async function handle(req, res) {
    if (!localHost(req.headers.host)) throw new HttpError(403, "the editor only answers on localhost");
    const url2 = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url2.pathname;
    if (!path.startsWith("/api/")) {
      const file = path === "/" ? "index.html" : normalize(path).replace(/^[/\\]+/, "");
      if (file.includes("..")) throw new HttpError(404, "not found");
      const abs = join2(editorDir, file);
      if (!existsSync2(abs)) {
        if (path === "/") throw new HttpError(500, `editor assets are missing from ${editorDir}; run npm run build`);
        throw new HttpError(404, "not found");
      }
      res.writeHead(200, {
        "content-type": MIME[extname(abs)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
      });
      res.end(readFileSync2(abs));
      return;
    }
    const given = req.headers["x-sysedit-token"] ?? url2.searchParams.get("t");
    if (given !== token) throw new HttpError(401, "missing or wrong token: open the editor from the link Claude gave you");
    const route = `${req.method} ${path}`;
    switch (route) {
      case "GET /api/events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      case "GET /api/state":
        return send(res, 200, app2.editorState());
      case "GET /api/source": {
        const file = url2.searchParams.get("file") ?? "";
        const start = Number(url2.searchParams.get("start") ?? "1");
        const end = Number(url2.searchParams.get("end") ?? String(start + 20));
        const lines = app2.store.readLines(file, start, end);
        if (!lines) throw new HttpError(404, `can't read ${file}`);
        return send(res, 200, lines);
      }
      case "PUT /api/change/ops": {
        const body = await readBody(req);
        if (!Array.isArray(body.ops)) throw new HttpError(400, "ops must be an array");
        return send(res, 200, app2.setOps(body.ops, "engineer", typeof body.intent === "string" ? body.intent : void 0));
      }
      case "POST /api/change/intent": {
        const body = await readBody(req);
        return send(res, 200, app2.setIntent(String(body.intent ?? "")));
      }
      case "POST /api/change/accept-op": {
        const body = await readBody(req);
        return send(res, 200, app2.acceptOp(Number(body.index)));
      }
      case "POST /api/change/remove-op": {
        const body = await readBody(req);
        return send(res, 200, app2.removeOp(Number(body.index)));
      }
      case "POST /api/change/submit":
        return send(res, 200, app2.submit());
      case "POST /api/answer": {
        const body = await readBody(req);
        return send(
          res,
          200,
          app2.answer({
            questionId: String(body.questionId ?? ""),
            optionId: body.optionId ? String(body.optionId) : void 0,
            text: body.text ? String(body.text) : void 0
          })
        );
      }
      case "POST /api/rate": {
        const body = await readBody(req);
        if (body.rating !== "useful" && body.rating !== "noise") throw new HttpError(400, "rating is useful or noise");
        return send(res, 200, app2.rate(String(body.questionId ?? ""), body.rating));
      }
      case "POST /api/dismiss": {
        const body = await readBody(req);
        return send(res, 200, app2.dismiss(String(body.questionId ?? "")));
      }
      case "POST /api/approve":
        return send(res, 200, app2.approve());
      case "GET /api/mermaid":
        return send(res, 200, { mermaid: app2.mermaid({ proposed: url2.searchParams.get("proposed") === "1" }) });
      default:
        throw new HttpError(404, `no route ${route}`);
    }
  }
  const port = opts.port ?? Number(process.env.SYSEDIT_PORT ?? 0);
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve2());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/?t=${token}`;
  return {
    url,
    port: actualPort,
    token,
    server,
    close: () => new Promise((resolve2) => {
      app2.off("changed", push);
      watcher?.close();
      for (const res of clients) res.end();
      clients.clear();
      server.close(() => resolve2());
      server.closeAllConnections?.();
    })
  };
}

// src/mcp/server.ts
import { createInterface } from "node:readline";

// src/mcp/app.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";

// src/mcp/tools.ts
var obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
var evidenceSchema = {
  type: "object",
  properties: {
    file: { type: "string", description: "Repository-relative path." },
    line: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    snippet: { type: "string", description: "The code at those lines, verbatim." }
  },
  required: ["file", "line"]
};
var opSchema = {
  type: "object",
  description: "One operation on the map: addNode {id, kind, label, file, takes, returns, note}, removeNode {id}, updateNode {id, ...}, addEdge {from, to, kind, label}, removeEdge {from, to}, rerouteEdge {from, to, newFrom?, newTo?}, addBranch {from, when, to}, annotate {target, note}.",
  properties: {
    op: { type: "string", enum: ["addNode", "removeNode", "updateNode", "addEdge", "removeEdge", "rerouteEdge", "addBranch", "annotate"] },
    quote: {
      type: "string",
      description: "The engineer's own words that this operation transcribes, verbatim. Without a quote the operation is only a suggestion the engineer must accept in the editor."
    }
  },
  required: ["op"],
  additionalProperties: true
};
var modelSchema = {
  type: "object",
  description: "A system model: {version: 1, commit, nodes: [{id, label, kind, level?, parent?, source: {file, lines: [first, last]}, external?, detail?, note?}], edges: [{from, to, kind, confidence: 'read'|'inferred', evidence?: {file, line, endLine?, snippet?}, when?, label?, note?}], flows: [{id, entry, entryNode, steps: [{edge, title, note?}]}]}. See schemas/model.schema.json in the plugin.",
  properties: {
    version: { const: 1 },
    commit: { type: "string" },
    nodes: { type: "array", items: { type: "object" } },
    edges: { type: "array", items: { type: "object" } },
    flows: { type: "array", items: { type: "object" } }
  },
  required: ["version", "commit", "nodes", "edges", "flows"]
};
var json = (value) => JSON.stringify(value, null, 2);
var TOOLS = [
  {
    name: "status",
    description: "Where the System Editor process stands: the stage, the active change, open blocking questions, whether the model is stale, and the editor URL. Call it first.",
    inputSchema: obj({}),
    run: ({}, { app: app2 }) => {
      const s = app2.status();
      return { text: json(s), data: s };
    }
  },
  {
    name: "save_model",
    description: `Validate and save the system model to .sysedit/model.json. Every node needs a source file and line range (unless external), and every edge read from code needs evidence (file and line); anything guessed from config, dynamic dispatch or an event bus must be confidence "inferred" with a note saying how. An invalid model is not saved; fix the errors and call again. Set merge: true when saving one entry point's slice into an existing model.`,
    inputSchema: obj({ model: modelSchema, merge: { type: "boolean" } }, ["model"]),
    run: ({ model, merge }, { app: app2 }) => {
      const { report, stats } = app2.saveModel(model, { merge: !!merge });
      return {
        text: `${report.ok ? "Saved." : "Not saved."} ${stats.nodes} nodes, ${stats.edges} edges (${stats.inferred} inferred), ${stats.flows} flows.
${formatReport(report)}`,
        data: { report, stats },
        isError: !report.ok
      };
    }
  },
  {
    name: "validate_model",
    description: "Check .sysedit/model.json against the files on disk: every source and evidence line must exist.",
    inputSchema: obj({}),
    run: ({}, { app: app2 }) => {
      const report = app2.validate();
      return { text: formatReport(report), data: report, isError: !report.ok };
    }
  },
  {
    name: "get_model",
    description: "Read the system model, optionally one flow and one detail level (services, modules, functions).",
    inputSchema: obj({ flow: { type: "string" }, level: { type: "string", enum: [...LEVELS] } }),
    run: ({ flow, level }, { app: app2 }) => {
      const model = app2.getModel({ flow, level });
      return { text: json(model), data: model };
    }
  },
  {
    name: "start_change",
    description: "Start a change set for the engineer's request, after the map is saved. Writes are then held outside .sysedit/ until the engineer has drawn the change, answered the blocking questions and approved it. Give the request verbatim and a short title.",
    inputSchema: obj(
      {
        title: { type: "string" },
        request: { type: "string", description: "The engineer's request, verbatim." },
        flow: { type: "string", description: "The flow the change will be drawn on." },
        risk: { type: "string", enum: ["low", "medium", "high"] }
      },
      ["title", "request"]
    ),
    run: ({ title, request, flow, risk }, { app: app2 }) => {
      const cs = app2.startChange({ title, request, flow, risk });
      return { text: `Started change ${cs.id} (${cs.risk} risk). Now ask the engineer to draw it: call open_editor.`, data: cs };
    }
  },
  {
    name: "get_change",
    description: "Read the active change set: the engineer's intent, the operations they drew, the proposed model with what was added and removed, the files it touches, questions and answers, and what still blocks approval.",
    inputSchema: obj({ id: { type: "string" } }),
    run: ({ id }, { app: app2 }) => {
      const c = app2.getChange(id);
      return { text: json(c), data: c };
    }
  },
  {
    name: "propose_ops",
    description: "Add operations to the map that the ENGINEER stated in chat, transcribed with their verbatim words in `quote`. Never invent the design: an operation without a quote is recorded as Claude's suggestion, shown dashed in the editor, and blocks approval until the engineer accepts or removes it.",
    inputSchema: obj({ ops: { type: "array", items: opSchema } }, ["ops"]),
    run: ({ ops }, { app: app2 }) => {
      const cs = app2.transcribeOps(ops);
      const suggested = cs.ops.filter((o) => o.by === "claude").length;
      return {
        text: `The map has ${cs.ops.length} operation(s)${suggested ? `, ${suggested} of them suggestions the engineer must accept` : ""}.`,
        data: cs
      };
    }
  },
  {
    name: "set_intent",
    description: "Record what the engineer is trying to do, in the engineer's words. Ask them; don't write it for them.",
    inputSchema: obj({ intent: { type: "string" } }, ["intent"]),
    run: ({ intent }, { app: app2 }) => ({ text: "Intent recorded.", data: app2.setIntent(intent) })
  },
  {
    name: "submit_change",
    description: "Submit the drawn change for review (usually the engineer does this from the editor). Needs an intent and at least one operation.",
    inputSchema: obj({}),
    run: ({}, { app: app2 }) => ({ text: "Submitted for review. Run the grill: /sysedit:grill.", data: app2.submit() })
  },
  {
    name: "add_questions",
    description: 'Ask the engineer questions about their change (the grill). Each question needs `evidence`: the file and line(s) of the code that prompted it; a question without evidence is dropped. severity is "blocking" only for a real risk the change does not address (rare); otherwise "worth-checking". Give 2\u20134 answer `options` where you can, each with the map `ops` that picking it applies and an `effect` sentence. category: intent, failure-mode, timeout, consistency, idempotency, retries, events, security, data, other.',
    inputSchema: obj(
      {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              severity: { type: "string", enum: ["blocking", "worth-checking"] },
              category: { type: "string" },
              target: { type: "string", description: "The node or edge, as the map labels it." },
              headline: { type: "string" },
              question: { type: "string" },
              evidence: { type: "array", items: evidenceSchema, minItems: 1 },
              checked: { type: "array", items: { type: "string" } },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    effect: { type: "string" },
                    ops: { type: "array", items: opSchema }
                  },
                  required: ["id", "label"]
                }
              }
            },
            required: ["severity", "category", "target", "question", "evidence"]
          }
        }
      },
      ["questions"]
    ),
    run: ({ questions }, { app: app2 }) => {
      const r = app2.addQuestions(questions);
      return {
        text: `Asked ${r.accepted.length} question(s); ${r.openBlocking} blocking open.` + (r.dropped.length ? `
Dropped:
${r.dropped.map((d) => `  ${d.id}: ${d.reason}`).join("\n")}` : ""),
        data: r
      };
    }
  },
  {
    name: "record_answer",
    description: "Record the ENGINEER's answer to a question: the option they picked, or their own words in `text`. `quote` is required: the engineer's words that give this answer, verbatim from what they typed (a word or two is enough, such as \"q2 b\"). Never answer for them, even when they ask you to; instead give each open question in one line with lettered options so they can answer in seconds, or point them to /sysedit:skip. `ops` adds map changes their answer implies.",
    inputSchema: obj(
      {
        questionId: { type: "string" },
        optionId: { type: "string" },
        text: { type: "string", description: "The engineer's answer, in their words." },
        quote: { type: "string", description: "What the engineer typed that gives this answer, verbatim." },
        ops: { type: "array", items: opSchema }
      },
      ["questionId", "quote"]
    ),
    run: ({ questionId, optionId, text: text2, ops, quote }, { app: app2 }) => {
      if (typeof quote !== "string" || quote.trim().length === 0) {
        return { text: "Not recorded: `quote` must hold the engineer's own words for this answer. If they haven't answered, ask them.", isError: true };
      }
      const cs = app2.answer({ questionId, optionId, text: text2, ops, quote });
      const open = cs.questions.filter((q) => q.severity === "blocking" && q.status === "open").length;
      return { text: `Recorded. ${open} blocking question(s) still open.`, data: cs };
    }
  },
  {
    name: "rate_question",
    description: "Record whether the engineer found a question useful or noise; noisy rubric items get cut.",
    inputSchema: obj({ questionId: { type: "string" }, rating: { type: "string", enum: ["useful", "noise"] } }, ["questionId", "rating"]),
    run: ({ questionId, rating }, { app: app2 }) => ({ text: "Rated.", data: app2.rate(questionId, rating) })
  },
  {
    name: "approve_change",
    description: 'Approve the change once the engineer says so. `quote` is required: their words approving it, verbatim ("approve it", "yes, go ahead"). Refused while a blocking question is open or a suggested operation is unaccepted. After approval, writes the map covers are allowed.',
    inputSchema: obj({ quote: { type: "string", description: "What the engineer typed to approve, verbatim." } }, ["quote"]),
    run: ({ quote }, { app: app2 }) => {
      if (typeof quote !== "string" || quote.trim().length === 0) {
        return { text: "Not approved: `quote` must hold the engineer's words approving the change. Ask them whether to approve.", isError: true };
      }
      return { text: "Approved. Plan it with /sysedit:plan.", data: app2.approve(quote) };
    }
  },
  {
    name: "save_plan",
    description: "Save the implementation plan for the approved change: one task per operation or group of operations. Each task lists `ops` (indexes into the change set's ops) and `files`. Every operation must be covered and no task may build anything that is not on the map; a plan that breaks either rule is refused.",
    inputSchema: obj(
      {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              ops: { type: "array", items: { type: "integer", minimum: 0 } },
              files: { type: "array", items: { type: "string" } },
              answers: { type: "array", items: { type: "string" } }
            },
            required: ["id", "title", "ops", "files"]
          }
        }
      },
      ["tasks"]
    ),
    run: ({ tasks }, { app: app2 }) => ({ text: "Plan saved.", data: app2.savePlan(tasks) })
  },
  {
    name: "mark_implemented",
    description: "Mark the approved change as built, before verifying it.",
    inputSchema: obj({}),
    run: ({}, { app: app2 }) => ({ text: "Marked implemented. Verify it with /sysedit:verify.", data: app2.markImplemented() })
  },
  {
    name: "verify_change",
    description: "Compare the built code with the approved map. Pass `actual`, a model re-mapped from the changed code (same ids for unchanged nodes, the drawn ids for new ones); without it the saved model is used. Reports edges drawn but not built, edges built but not drawn, and edges removed on the map but still in the code.",
    inputSchema: obj({ actual: modelSchema }),
    run: ({ actual }, { app: app2 }) => {
      const drift = app2.verify(actual);
      return { text: formatDrift(drift), data: drift, isError: false };
    }
  },
  {
    name: "set_adr",
    description: "Record the path of the decision record written for the change.",
    inputSchema: obj({ path: { type: "string" } }, ["path"]),
    run: ({ path }, { app: app2 }) => ({ text: "Recorded.", data: app2.setAdr(path) })
  },
  {
    name: "skip_change",
    description: "Skip the process for a change too small to need it, when the ENGINEER asks to. `reason` is the engineer's reason and `quote` their words asking to skip, verbatim. Never skip on your own initiative. The skip is logged (the skip rate is a tracked metric) and writes are let through.",
    inputSchema: obj(
      {
        reason: { type: "string" },
        quote: { type: "string", description: "What the engineer typed asking to skip, verbatim." },
        title: { type: "string" }
      },
      ["reason", "quote"]
    ),
    run: ({ reason, title, quote }, { app: app2 }) => {
      if (typeof quote !== "string" || quote.trim().length === 0) {
        return { text: "Not skipped: `quote` must hold the engineer's words asking to skip. Skipping is their call.", isError: true };
      }
      const r = app2.skip(reason, { title });
      return { text: r.change ? `Skipped ${r.change.id}; reason logged.` : "Skip logged; no change was in progress.", data: r };
    }
  },
  {
    name: "close_change",
    description: "Clear the active change once it is verified or skipped.",
    inputSchema: obj({}),
    run: ({}, { app: app2 }) => {
      app2.closeChange();
      return { text: "No change is active now." };
    }
  },
  {
    name: "open_editor",
    description: "Start the System Editor on localhost and return its URL, for the engineer to trace the flow, draw the change and answer questions. Give the engineer the URL.",
    inputSchema: obj({}),
    run: async ({}, { app: app2, openEditor }) => {
      const server = await openEditor();
      app2.store.writeState({ editorUrl: server.url });
      return { text: `System Editor: ${server.url}`, data: { url: server.url } };
    }
  },
  {
    name: "render_mermaid",
    description: "Render the model, one flow, or the proposed change as a Mermaid flowchart, for a terminal, PR or ADR.",
    inputSchema: obj({ flow: { type: "string" }, proposed: { type: "boolean" } }),
    run: ({ flow, proposed }, { app: app2 }) => {
      const text2 = app2.mermaid({ flow, proposed });
      return { text: text2, data: { mermaid: text2 } };
    }
  },
  {
    name: "record_explain_back",
    description: "Record an explain-back check: the engineer explained a flow without the tool, and you scored the share of its steps they got right (0 to 1) and listed what they missed.",
    inputSchema: obj(
      {
        flow: { type: "string" },
        change: { type: "string" },
        score: { type: "number", minimum: 0, maximum: 1 },
        missed: { type: "array", items: { type: "string" } }
      },
      ["flow", "score", "missed"]
    ),
    run: ({ flow, change, score, missed }, { app: app2 }) => {
      const r = app2.explainBack({ flow, change, score, missed });
      return { text: `Recorded explain-back for ${flow}: ${Math.round(r.score * 100)}%.`, data: r };
    }
  },
  {
    name: "get_metrics",
    description: "The process metrics: time to submit, time in review, grill hit rate, drift caught, skip rate, explain-back scores.",
    inputSchema: obj({}),
    run: ({}, { app: app2 }) => {
      const m = app2.metrics();
      return { text: formatMetrics(m), data: m };
    }
  }
];

// src/mcp/app.ts
var UI_EXTENSION = "io.modelcontextprotocol/ui";
var UI_MIME = "text/html;profile=mcp-app";
var EDITOR_URI = "ui://sysedit/editor";
var TABS = ["trace", "edit", "grill", "plan"];
function rendersApps(capabilities) {
  const ext = capabilities?.extensions?.[UI_EXTENSION];
  return Array.isArray(ext?.mimeTypes) && ext.mimeTypes.includes(UI_MIME);
}
var EDITOR_RESOURCE = {
  uri: EDITOR_URI,
  name: "System Editor",
  description: "Trace the flow, draw the change, and answer Claude\u2019s questions, inline in the chat.",
  mimeType: UI_MIME
};
function editorHtml(editorDir = defaultEditorDir()) {
  const js = join3(editorDir, "app.js");
  const css = join3(editorDir, "app.css");
  if (!existsSync3(js) || !existsSync3(css)) throw new Error(`editor assets are missing from ${editorDir}; run npm run build`);
  const script = readFileSync3(js, "utf8").replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  const style = readFileSync3(css, "utf8").replace(/<\/style/gi, "<\\/style");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>System Editor</title>",
    `<style>${style}</style>`,
    "</head>",
    '<body class="in-chat">',
    '<div id="app"><p class="boot">Loading System Editor\u2026</p></div>',
    '<script>window.__SYSEDIT__ = { transport: "mcp-app" }</script>',
    `<script type="module">${script}</script>`,
    "</body>",
    "</html>"
  ].join("\n");
}
function readEditorResource(editorDir) {
  return {
    contents: [
      {
        uri: EDITOR_URI,
        mimeType: UI_MIME,
        text: editorHtml(editorDir),
        // No external origins: everything is inline, and data comes through the host.
        _meta: { ui: { csp: {}, prefersBorder: true } }
      }
    ]
  };
}
var app = (name, description, inputSchema, run) => ({
  name,
  description,
  inputSchema,
  ui: { resourceUri: EDITOR_URI, visibility: ["app"] },
  run
});
var state = (ctx) => ctx.app.editorState();
var SHOW_EDITOR = {
  name: "show_editor",
  description: "Show the System Editor inline in this conversation, where the engineer traces the flow on the map, draws the change, and answers your questions. Use it after the map is saved and a change is started, and again whenever the engineer should look at or act on the map. `tab` opens a screen: trace, edit, grill or plan. `focus` names a box to trace to. The engineer acts in the editor; you never act for them.",
  inputSchema: obj({ tab: { type: "string", enum: TABS }, focus: { type: "string" } }),
  ui: { resourceUri: EDITOR_URI, visibility: ["model", "app"] },
  run: (_args, ctx) => {
    const s = ctx.app.editorState();
    const lines = [`System Editor is shown in the conversation: ${s.status.stageLabel}.`];
    if (s.change) {
      const cs = s.change.change;
      lines.push(`Change ${cs.id}: ${cs.title} [${cs.status}], ${cs.ops.length} operation(s) drawn, ${cs.questions.length} question(s).`);
      if (s.change.blockers.length && cs.status === "in-review") lines.push(`Waiting on the engineer: ${s.change.blockers.join("; ")}.`);
    } else if (!s.model) {
      lines.push("There is no map yet: map the code first.");
    }
    return { text: lines.join("\n"), structured: state(ctx) };
  }
};
var APP_TOOLS = [
  app("app_state", "The editor\u2019s view of .sysedit/: status, model, and the active change.", obj({}), (_a, ctx) => ({ text: "state", structured: state(ctx) })),
  app(
    "app_source",
    "Lines of a repository file, for the code beside each step.",
    obj({ file: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, ["file", "start", "end"]),
    ({ file, start, end }, ctx) => {
      const lines = ctx.app.store.readLines(String(file), Number(start), Number(end));
      if (!lines) return { text: `can't read ${file}`, isError: true };
      return { text: `${file}:${lines.start}`, structured: lines };
    }
  ),
  app(
    "app_set_ops",
    "Save the map the engineer drew, and optionally their intent.",
    obj({ ops: { type: "array", items: opSchema }, intent: { type: "string" } }, ["ops"]),
    ({ ops, intent }, ctx) => {
      ctx.app.setOps(ops, "engineer", typeof intent === "string" ? intent : void 0);
      return { text: "saved", structured: state(ctx) };
    }
  ),
  app("app_set_intent", "Save what the engineer is trying to do.", obj({ intent: { type: "string" } }, ["intent"]), ({ intent }, ctx) => {
    ctx.app.setIntent(String(intent));
    return { text: "saved", structured: state(ctx) };
  }),
  app("app_accept_op", "The engineer accepts an operation Claude suggested.", obj({ index: { type: "integer" } }, ["index"]), ({ index }, ctx) => {
    ctx.app.acceptOp(Number(index));
    return { text: "accepted", structured: state(ctx) };
  }),
  app("app_remove_op", "The engineer removes an operation from the map.", obj({ index: { type: "integer" } }, ["index"]), ({ index }, ctx) => {
    ctx.app.removeOp(Number(index));
    return { text: "removed", structured: state(ctx) };
  }),
  app("app_submit", "The engineer submits the drawn change for review.", obj({}), (_a, ctx) => {
    ctx.app.submit();
    return { text: "submitted", structured: state(ctx) };
  }),
  app(
    "app_answer",
    "The engineer answers a question: an option, or their own words.",
    obj({ questionId: { type: "string" }, optionId: { type: "string" }, text: { type: "string" } }, ["questionId"]),
    ({ questionId, optionId, text: text2 }, ctx) => {
      ctx.app.answer({ questionId: String(questionId), optionId: optionId ? String(optionId) : void 0, text: text2 ? String(text2) : void 0 });
      return { text: "answered", structured: state(ctx) };
    }
  ),
  app(
    "app_rate",
    "The engineer rates a question useful or noise.",
    obj({ questionId: { type: "string" }, rating: { type: "string", enum: ["useful", "noise"] } }, ["questionId", "rating"]),
    ({ questionId, rating }, ctx) => {
      ctx.app.rate(String(questionId), rating === "noise" ? "noise" : "useful");
      return { text: "rated", structured: state(ctx) };
    }
  ),
  app("app_dismiss", "The engineer dismisses a worth-checking question.", obj({ questionId: { type: "string" } }, ["questionId"]), ({ questionId }, ctx) => {
    ctx.app.dismiss(String(questionId));
    return { text: "dismissed", structured: state(ctx) };
  }),
  app("app_approve", "The engineer approves the change from the editor.", obj({}), (_a, ctx) => {
    ctx.app.approve("Approved in the System Editor");
    return { text: "approved", structured: state(ctx) };
  })
];

// src/mcp/server.ts
var SERVER_INFO = { name: "sysedit", version: "0.1.0" };
var SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
var INSTRUCTIONS = "System Editor keeps the engineer designing the change. Claude maps the code (with evidence for every edge), the engineer draws the change in the editor, Claude questions it with evidence, the engineer answers, and only then does Claude plan and build what was approved. Never draw the design or answer questions for the engineer.";
var APP_INSTRUCTIONS = "This host renders the System Editor in the conversation: call show_editor to put it in front of the engineer (after the map is saved and a change is started, and whenever they should act on it). The engineer draws, answers and approves there; their submit or approval arrives as their next message.";
function createHandler(app2, opts = {}) {
  let editor;
  const ctx = {
    app: app2,
    openEditor: async () => editor ??= await startEditorServer(app2, { editorDir: opts.editorDir })
  };
  let apps = false;
  const listed = () => apps ? [...TOOLS, SHOW_EDITOR, ...APP_TOOLS] : TOOLS;
  const handle = async (message) => {
    const { id, method, params } = message;
    const isRequest = id !== void 0 && id !== null;
    const reply = (result) => isRequest ? { jsonrpc: "2.0", id, result } : null;
    const error = (code, text2) => isRequest ? { jsonrpc: "2.0", id, error: { code, message: text2 } } : null;
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        apps = rendersApps(params?.capabilities);
        return reply({
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: apps ? `${INSTRUCTIONS} ${APP_INSTRUCTIONS}` : INSTRUCTIONS
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: listed().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...t.ui && { _meta: { ui: t.ui } }
          }))
        });
      case "resources/list":
        return reply({ resources: apps ? [EDITOR_RESOURCE] : [] });
      case "resources/templates/list":
        return reply({ resourceTemplates: [] });
      case "resources/read": {
        if (params?.uri !== EDITOR_URI) return error(-32002, `unknown resource ${params?.uri}`);
        try {
          return reply(readEditorResource(opts.editorDir));
        } catch (e) {
          return error(-32603, e instanceof Error ? e.message : String(e));
        }
      }
      case "tools/call": {
        const tool = listed().find((t) => t.name === params?.name);
        if (!tool) return error(-32602, `unknown tool ${params?.name}`);
        try {
          const result = await tool.run(params?.arguments ?? {}, ctx);
          return reply({
            content: [{ type: "text", text: result.text }],
            ...result.structured && { structuredContent: result.structured },
            isError: !!result.isError
          });
        } catch (e) {
          const text2 = e instanceof SyseditError ? e.message : `sysedit failed: ${e instanceof Error ? e.message : String(e)}`;
          return reply({ content: [{ type: "text", text: text2 }], isError: true });
        }
      }
      default:
        if (!isRequest) return null;
        return error(-32601, `method not found: ${method}`);
    }
  };
  return { handle, close: async () => editor?.close(), rendersApps: () => apps };
}
async function serveStdio(app2, opts = {}) {
  const { handle, close } = createHandler(app2, opts);
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = /* @__PURE__ */ new Set();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const p = handle(message).then((out) => {
      if (out) write(out);
    }).catch((e) => {
      if (message.id !== void 0) write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(e) } });
    }).finally(() => pending.delete(p));
    pending.add(p);
  });
  await new Promise((resolve2) => rl.once("close", resolve2));
  await Promise.allSettled([...pending]);
  await close();
}

// src/cli/main.ts
var HELP = `sysedit \u2014 System Editor for Claude Code

Usage: sysedit <command> [options]

  mcp                      Run the MCP server on stdio (Claude Code starts this)
  serve [--port N]         Start the editor on localhost and print its URL
  status [--json]          Stage, active change, open blocking questions
  validate [model.json]    Check a model (default .sysedit/model.json) against the code
  mermaid [--flow ID] [--proposed]
                           Print the model, a flow, or the proposed change as Mermaid
  verify --actual FILE     Compare a re-mapped model with the approved change
  skip --reason TEXT       Skip the process for the active change; the reason is logged
  metrics [--json]         Process metrics
  gate                     PreToolUse hook: read the tool call on stdin, hold writes until approved
  ci                       Fail when a change set in .sysedit/ isn't verified or skipped
  desktop-config           Print the Claude desktop config entry for this repository,
                           so the editor can open inside the chat

Options: --root DIR (default: $SYSEDIT_ROOT, $CLAUDE_PROJECT_DIR, or the working directory)
`;
function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : void 0;
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function main(argv) {
  const [command2, ...args] = argv;
  const root = flag(args, "root");
  const out = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
  const errOut = (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");
  if (!command2 || command2 === "help" || command2 === "--help" || command2 === "-h") {
    out(HELP);
    return 0;
  }
  const app2 = new Sysedit(root);
  switch (command2) {
    case "mcp":
      await serveStdio(app2);
      return 0;
    case "serve": {
      const port = flag(args, "port");
      const server = await startEditorServer(app2, { port: port ? Number(port) : void 0 });
      app2.store.writeState({ editorUrl: server.url });
      out(`System Editor: ${server.url}`);
      await new Promise((resolve2) => {
        process.once("SIGINT", resolve2);
        process.once("SIGTERM", resolve2);
      });
      await server.close();
      return 0;
    }
    case "status": {
      const s = app2.status();
      if (args.includes("--json")) {
        out(JSON.stringify(s, null, 2));
        return 0;
      }
      out(`${s.repo} @ ${s.head} \xB7 ${s.stageLabel}`);
      if (s.model) out(`Model: ${s.model.nodes} nodes, ${s.model.edges} edges (${s.model.inferred} inferred) from ${s.model.commit}${s.model.stale ? " (stale)" : ""}`);
      else out("Model: none yet (run /sysedit:map)");
      if (s.change) {
        out(`Change ${s.change.id}: ${s.change.title} [${s.change.status}, ${s.change.risk ?? "?"} risk]`);
        for (const q of s.change.openBlocking) out(`  blocking ${q.id} \xB7 ${q.target}: ${q.question}`);
        for (const b of s.change.blockers) out(`  needs: ${b}`);
      }
      if (s.editorUrl) out(`Editor: ${s.editorUrl}`);
      return 0;
    }
    case "validate": {
      const file = args.find((a) => !a.startsWith("--") && a !== root);
      const model = file ? JSON.parse(readFileSync4(file, "utf8")) : void 0;
      const report = app2.validate(model);
      out(formatReport(report));
      return report.ok ? 0 : 1;
    }
    case "mermaid":
      out(app2.mermaid({ flow: flag(args, "flow"), proposed: args.includes("--proposed") }));
      return 0;
    case "verify": {
      const file = flag(args, "actual");
      const actual = file ? JSON.parse(readFileSync4(file, "utf8")) : void 0;
      const drift = app2.verify(actual);
      out(formatDrift(drift));
      return drift.ok ? 0 : 1;
    }
    case "skip": {
      const reason = flag(args, "reason");
      if (!reason) {
        errOut(`sysedit skip needs --reason "why this change doesn't need the process"`);
        return 2;
      }
      const r = app2.skip(reason);
      out(r.change ? `Skipped ${r.change.id}; reason logged.` : "Skip logged.");
      return 0;
    }
    case "metrics": {
      const m = app2.metrics();
      out(args.includes("--json") ? JSON.stringify(m, null, 2) : formatMetrics(m));
      return 0;
    }
    case "gate": {
      const input = JSON.parse(await readStdin() || "{}");
      const mode = process.env.SYSEDIT_GATE_MODE ?? process.env.CLAUDE_PLUGIN_OPTION_GATE_MODE ?? "approved-only";
      let change = null;
      let model = null;
      try {
        change = app2.store.activeChange();
        model = app2.store.readModel();
      } catch {
      }
      const decision = decide({
        tool: String(input.tool_name ?? ""),
        filePath: input.tool_input?.file_path ?? input.tool_input?.notebook_path,
        root: app2.store.root,
        cwd: input.cwd ?? app2.store.root,
        mode,
        change,
        model
      });
      if (!decision.allow) {
        out(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.reason
            }
          })
        );
      }
      return 0;
    }
    case "ci": {
      const problems = [];
      const report = app2.validate();
      if (app2.store.readModel() && !report.ok) problems.push(`model: ${report.errors.length} error(s)
${formatReport(report)}`);
      for (const cs of app2.store.listChanges()) {
        if (cs.status === "verified" || cs.status === "skipped") continue;
        problems.push(`change ${cs.id} is ${cs.status}: verify it (/sysedit:verify) or skip it with a reason before merging`);
        if (cs.drift && !cs.drift.ok) problems.push(formatDrift(cs.drift));
      }
      if (problems.length === 0) {
        out("sysedit: every change set is verified or skipped.");
        return 0;
      }
      errOut(problems.join("\n"));
      return 1;
    }
    case "desktop-config": {
      const entry = { command: process.execPath, args: [fileURLToPath2(import.meta.url), "mcp"], env: { SYSEDIT_ROOT: app2.store.root } };
      out(JSON.stringify({ mcpServers: { sysedit: entry } }, null, 2));
      return 0;
    }
    default:
      errOut(`unknown command "${command2}"

${HELP}`);
      return 2;
  }
}

// src/cli/entry.ts
var command = process.argv[2];
main(process.argv.slice(2)).then(
  (code) => {
    if (command !== "mcp" && command !== "serve") process.exit(code);
  },
  (error) => {
    process.stderr.write(`${error instanceof SyseditError ? error.message : error instanceof Error ? error.stack : String(error)}
`);
    process.exit(1);
  }
);
