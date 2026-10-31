"use strict";

// Dev Status — GlobalProtect VPN (with connect/disconnect) + service health.
// Talks to Extensions/dev-bridge.

var BRIDGE = "http://127.0.0.1:7831";

var vpn = null;            // /vpn payload
var services = [];         // /services payload items
var bridgeError = null;
var busy = null;           // "connecting" | "disconnecting" | null
var actionError = null;
var activeTab = "vpn";     // "vpn" | "services"
var timerID = null;

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
  call("GET", "/services").then(function (r) {
    var before = services;
    services = r.items || [];
    before.forEach(function (b) {
      var now = services.filter(function (x) { return x.name === b.name; })[0];
      if (now && b.up && !now.up && setting("notifyVpn", true)) { notify(b.name + " is down", now.target); SuperIsland.playFeedback("warning"); }
    });
  }).catch(function () {});
}

function servicesDown() { return services.filter(function (x) { return !x.up; }); }

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
  var down = servicesDown().length;
  return View.hstack([
    View.icon(vpn && vpn.connected ? "lock.shield.fill" : "lock.open", { color: vpnColor(), size: 13 }),
    View.spacer(),
    View.text(down > 0 ? down + " svc down" : vpnLabel(),
              { style: "caption", color: down > 0 ? "yellow" : "white", lineLimit: 1 })
  ], { spacing: 6, align: "center" });
}

function tabBar() {
  function tab(id, label) {
    return View.button(View.text(label, { style: "caption", color: activeTab === id ? "white" : "gray" }), "tab-" + id);
  }
  return View.hstack([tab("vpn", "VPN"), tab("services", "Services")], { spacing: 14 });
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

function servicesPanel() {
  if (services.length === 0) return [View.text("Checking services…", { style: "caption", color: "gray" })];
  return services.map(function (x) {
    return View.hstack([
      View.icon("circle.fill", { size: 8, color: x.up ? "green" : "red" }),
      View.text(x.name, { style: "body" }),
      View.spacer(),
      View.text(x.up ? x.ms + " ms" : "down", { style: "caption", color: x.up ? "gray" : "red" }),
      View.text(x.target, { style: "monospacedSmall", color: "gray" })
    ], { spacing: 8, align: "center" });
  });
}

function body() {
  if (bridgeError) return [View.text(bridgeError, { style: "caption", color: "orange", lineLimit: 3 })];
  if (activeTab === "vpn") return vpnPanel();
  return servicesPanel();
}

function expandedView() {
  var header = View.hstack([
    View.text(activeTab === "vpn" ? "VPN" : "Services", { style: "title" }),
    View.spacer(), tabBar(),
    View.button(View.icon("arrow.clockwise", { size: 12, color: "gray" }), "refresh")
  ], { spacing: 10, align: "center" });
  return View.padding(View.vstack([header].concat(body()), { spacing: 6, align: "leading" }), { amount: 8 });
}

function fullExpandedView() {
  var summary = View.hstack([
    View.text(vpnLabel(), { style: "caption", color: vpnColor() }),
    View.text(servicesDown().length === 0 ? "All services up" : servicesDown().length + " service(s) down", { style: "caption", color: "gray" })
  ], { spacing: 12 });
  return View.padding(View.vstack([
    View.hstack([View.text("Dev Status", { style: "title" }), View.spacer(), tabBar()], { spacing: 10 }),
    summary,
    View.scroll(View.vstack(body(), { spacing: 6, align: "leading" }), { axes: "vertical" })
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
