"use strict";

// Dev Status — GlobalProtect VPN (with connect/disconnect) + Cornercase
// (local and remote VPS) agents and worktrees. Talks to Extensions/dev-bridge.

var BRIDGE = "http://127.0.0.1:7831";

var vpn = null;            // /vpn payload
var cc = null;             // /cornercase payload
var bridgeError = null;
var busy = null;           // "connecting" | "disconnecting" | null
var actionError = null;
var activeTab = "vpn";     // "vpn" | "agents" | "worktrees"
var timerID = null;
var firstLoad = true;
var prevAgentStatus = {};

function setting(key, fallback) {
  var v = SuperIsland.settings.get(key);
  return v === null || v === undefined ? fallback : v;
}
function pollMs() { return (Number(setting("pollSeconds", "10")) || 10) * 1000; }

function call(method, path, body) {
  var opts = { method: method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return SuperIsland.http.fetch(BRIDGE + path, opts).then(function (res) {
    if (res.error || res.status >= 400) throw new Error(res.error || ("HTTP " + res.status));
    return res.data || (res.text ? JSON.parse(res.text) : {});
  });
}

function notify(title, body) {
  SuperIsland.notifications.send({ title: title, body: body, sound: false, appName: "Dev Status" });
}

function refresh() {
  call("GET", "/vpn").then(function (v) {
    var was = vpn;
    vpn = v; bridgeError = null;
    if (was && was.connected !== v.connected && !busy && setting("notifyVpn", true)) {
      notify(v.connected ? "VPN connected" : "VPN disconnected", v.connected ? (v.ip || "") : "GlobalProtect is down");
      SuperIsland.playFeedback(v.connected ? "success" : "warning");
    }
    if (busy === "connecting" && v.connected) busy = null;
    if (busy === "disconnecting" && !v.connected) busy = null;
  }).catch(function (e) {
    bridgeError = "Dev bridge not running (" + e.message + "). Run Extensions/dev-bridge/install.sh";
  });
  call("GET", "/cornercase").then(function (c) {
    cc = c; trackAgents(c);
  }).catch(function () {});
}

function trackAgents(c) {
  var seen = {};
  ["local", "remote"].forEach(function (side) {
    var s = c[side];
    if (!s || !s.ok) return;
    s.agents.forEach(function (a) {
      var key = side + ":" + a.id;
      seen[key] = a.status;
      var before = prevAgentStatus[key];
      if (!firstLoad && before === "working" && a.status !== "working" && setting("notifyAgents", true)) {
        var failed = a.status === "failed";
        notify(failed ? "Agent failed" : "Agent finished", a.agent + " · " + a.project + "/" + a.workspace + " (" + side + ")");
        SuperIsland.playFeedback(failed ? "error" : "success");
        SuperIsland.island.activate(true);
      }
    });
  });
  prevAgentStatus = seen;
  firstLoad = false;
}

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

function allAgents() {
  var out = [];
  ["local", "remote"].forEach(function (side) {
    var s = cc && cc[side];
    if (s && s.ok) s.agents.forEach(function (a) { out.push({ side: side, a: a }); });
  });
  return out;
}
function countStatus(st) { return allAgents().filter(function (x) { return x.a.status === st; }).length; }
function allWorktrees() {
  var out = [];
  ["local", "remote"].forEach(function (side) {
    var s = cc && cc[side];
    if (s && s.ok) (s.worktrees || []).forEach(function (w) { out.push({ side: side, w: w }); });
  });
  return out;
}
function removableWorktrees() { return allWorktrees().filter(function (x) { return x.w.merged || x.w.prunable; }); }

function vpnColor() {
  if (busy) return "yellow";
  if (!vpn) return "gray";
  return vpn.connected ? "green" : "red";
}
function vpnLabel() {
  if (busy) return busy === "connecting" ? "Connecting…" : "Disconnecting…";
  if (!vpn) return "VPN ?";
  return vpn.connected ? "VPN on" : "VPN off";
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function compactView() {
  var working = countStatus("working");
  var done = removableWorktrees().length;
  return View.hstack([
    View.icon(vpn && vpn.connected ? "lock.shield.fill" : "lock.open", { color: vpnColor(), size: 13 }),
    View.spacer(),
    View.text(working > 0 ? working + " working" : (done > 0 ? done + " to clean" : vpnLabel()),
              { style: "caption", color: working > 0 ? "yellow" : "white", lineLimit: 1 })
  ], { spacing: 6, align: "center" });
}

function tabBar() {
  function tab(id, label) {
    return View.button(View.text(label, { style: "caption", color: activeTab === id ? "white" : "gray" }), "tab-" + id);
  }
  return View.hstack([tab("vpn", "VPN"), tab("agents", "Agents"), tab("worktrees", "Worktrees")], { spacing: 14 });
}

function vpnPanel() {
  var rows = [];
  rows.push(View.hstack([
    View.icon(vpn && vpn.connected ? "lock.shield.fill" : "lock.open", { color: vpnColor(), size: 22 }),
    View.vstack([
      View.text("GlobalProtect · " + vpnLabel(), { style: "title" }),
      View.text(vpn && vpn.connected
        ? (vpn.ip + " · " + vpn.iface + " · GitLab " + (vpn.gitlabReachable ? "reachable" : "unreachable"))
        : "Tunnel is down", { style: "caption", color: "gray" })
    ], { spacing: 2, align: "leading" }),
    View.spacer(),
    vpn && vpn.connected
      ? View.button(View.text(busy ? "…" : "Disconnect", { style: "body", color: "red" }), "vpn-disconnect")
      : View.button(View.text(busy ? "…" : "Connect", { style: "body", color: "green" }), "vpn-connect")
  ], { spacing: 10, align: "center" }));
  if (actionError) rows.push(View.text(actionError, { style: "caption", color: "orange", lineLimit: 2 }));
  return rows;
}

function agentRow(x) {
  var a = x.a;
  var color = { working: "yellow", waiting: "orange", failed: "red", done: "green", idle: "gray" }[a.status] || "gray";
  return View.hstack([
    View.icon("circle.fill", { color: color, size: 8 }),
    View.text(a.project + "/" + a.workspace, { style: "body", lineLimit: 1 }),
    View.spacer(),
    View.text((a.agent || "") + " · " + a.status + " · " + x.side, { style: "caption", color: "gray", lineLimit: 1 })
  ], { spacing: 8, align: "center" });
}

function agentsPanel(limit) {
  if (!cc) return [View.text("Loading Cornercase…", { style: "caption", color: "gray" })];
  var rows = [];
  ["local", "remote"].forEach(function (side) {
    var s = cc[side];
    if (!s.ok) rows.push(View.text(side + ": " + s.error, { style: "caption", color: "gray", lineLimit: 1 }));
  });
  var agents = allAgents();
  if (agents.length === 0) rows.push(View.text("No agents running", { style: "caption", color: "gray" }));
  agents.slice(0, limit).forEach(function (x) { rows.push(agentRow(x)); });
  return rows;
}

function worktreesPanel(limit) {
  if (!cc) return [View.text("Loading Cornercase…", { style: "caption", color: "gray" })];
  var wts = allWorktrees();
  var rows = [];
  if (wts.length === 0) rows.push(View.text("No worktrees on disk", { style: "caption", color: "gray" }));
  // Removable (merged / leftovers) first.
  wts.sort(function (a, b) { return (b.w.merged || b.w.prunable ? 1 : 0) - (a.w.merged || a.w.prunable ? 1 : 0); });
  wts.slice(0, limit).forEach(function (x) {
    var flag = x.w.prunable ? "leftover" : (x.w.merged ? "merged" : "active");
    rows.push(View.hstack([
      View.icon(x.w.merged || x.w.prunable ? "checkmark.circle.fill" : "arrow.triangle.branch",
                { color: x.w.merged || x.w.prunable ? "green" : "gray", size: 11 }),
      View.text((x.w.project || "?") + " · " + (x.w.branch || "?"), { style: "body", lineLimit: 1 }),
      View.spacer(),
      View.text(flag + " · " + x.side, { style: "caption", color: "gray" })
    ], { spacing: 8, align: "center" }));
  });
  return rows;
}

function body(limit) {
  if (bridgeError) return [View.text(bridgeError, { style: "caption", color: "orange", lineLimit: 3 })];
  if (activeTab === "vpn") return vpnPanel();
  if (activeTab === "agents") return agentsPanel(limit);
  return worktreesPanel(limit);
}

function expandedView() {
  var header = View.hstack([
    View.text(activeTab === "vpn" ? "VPN" : activeTab === "agents" ? "Agents" : "Worktrees", { style: "title" }),
    View.spacer(), tabBar(),
    View.button(View.icon("arrow.clockwise", { size: 12, color: "gray" }), "refresh")
  ], { spacing: 10, align: "center" });
  return View.padding(View.vstack([header].concat(body(3)), { spacing: 6, align: "leading" }), { amount: 8 });
}

function fullExpandedView() {
  var summary = View.hstack([
    View.text(vpnLabel(), { style: "caption", color: vpnColor() }),
    View.text(countStatus("working") + " working · " + countStatus("waiting") + " waiting · " +
              removableWorktrees().length + " worktrees to clean", { style: "caption", color: "gray" })
  ], { spacing: 12 });
  return View.padding(View.vstack([
    View.hstack([View.text("Dev Status", { style: "title" }), View.spacer(), tabBar()], { spacing: 10 }),
    summary,
    View.scroll(View.vstack(body(30), { spacing: 6, align: "leading" }), { axes: "vertical" })
  ], { spacing: 8, align: "leading" }), { amount: 10 });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function vpnToggle(connect) {
  busy = connect ? "connecting" : "disconnecting";
  actionError = null;
  call("POST", connect ? "/vpn/connect" : "/vpn/disconnect").then(function (r) {
    if (!r.ok) { busy = null; actionError = r.error; SuperIsland.playFeedback("error"); }
    // Safety net so the UI never sticks in "busy".
    setTimeout(function () { busy = null; refresh(); }, 30000);
    setTimeout(refresh, 3000);
  }).catch(function (e) { busy = null; actionError = e.message; });
}

function start() {
  refresh();
  if (timerID === null) timerID = setInterval(refresh, pollMs());
}

SuperIsland.registerModule({
  onActivate: start,
  onDeactivate: function () { if (timerID !== null) { clearInterval(timerID); timerID = null; } },
  onAction: function (id) {
    if (id === "vpn-connect") return vpnToggle(true);
    if (id === "vpn-disconnect") return vpnToggle(false);
    if (id === "refresh") { refresh(); return; }
    if (id.indexOf("tab-") === 0) { activeTab = id.slice(4); SuperIsland.playFeedback("selection"); }
  },
  compact: compactView,
  expanded: expandedView,
  fullExpanded: fullExpandedView
});

start();
