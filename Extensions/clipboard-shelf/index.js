"use strict";

// Clipboard Shelf — history served by Extensions/dev-bridge (password-manager
// / concealed pasteboard entries are never recorded).

var BRIDGE = "http://127.0.0.1:7831";
var items = [];
var error = null;
var toast = null;       // { text, until }
var lastTopID = null;
var timerID = null;

function call(method, path, body) {
  var opts = { method: method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return SuperIsland.http.fetch(BRIDGE + path, opts).then(function (res) {
    if (res.error || res.status >= 400) throw new Error(res.error || ("HTTP " + res.status));
    return res.data || (res.text ? JSON.parse(res.text) : {});
  });
}

function refresh() {
  call("GET", "/clipboard").then(function (r) {
    items = r.items || []; error = null;
    var top = items.filter(function (i) { return !i.pinned; })[0];
    if (top && lastTopID !== null && top.id !== lastTopID && SuperIsland.settings.get("autoReveal")) {
      SuperIsland.island.activate(true);
    }
    if (top) lastTopID = top.id; else if (lastTopID === null) lastTopID = 0;
  }).catch(function (e) { error = "Dev bridge not running (" + e.message + ")"; });
}

function oneLine(t, n) {
  var s = String(t).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function itemRow(it, width) {
  return View.hstack([
    View.button(View.hstack([
      View.icon(it.pinned ? "pin.fill" : "doc.on.clipboard", { size: 11, color: it.pinned ? "yellow" : "gray" }),
      View.text(oneLine(it.text, width), { style: "body", lineLimit: 1 })
    ], { spacing: 8, align: "center" }), "copy:" + it.id),
    View.spacer(),
    View.button(View.icon(it.pinned ? "pin.slash" : "pin", { size: 11, color: "gray" }), "pin:" + it.id),
    View.button(View.icon("xmark", { size: 10, color: "gray" }), "del:" + it.id)
  ], { spacing: 8, align: "center" });
}

function compactView() {
  var recent = items[0];
  return View.hstack([
    View.icon("doc.on.clipboard", { size: 12, color: "teal" }),
    View.spacer(),
    View.text(toast && toast.until > Date.now() ? "Copied" : (recent ? oneLine(recent.text, 18) : "Clipboard"),
              { style: "caption", lineLimit: 1 })
  ], { spacing: 6, align: "center" });
}

function expandedView() {
  var rows = error ? [View.text(error, { style: "caption", color: "orange", lineLimit: 2 })]
    : (items.length === 0 ? [View.text("Nothing copied yet", { style: "caption", color: "gray" })]
       : items.slice(0, 3).map(function (i) { return itemRow(i, 38); }));
  return View.padding(View.vstack([
    View.hstack([View.text("Clipboard", { style: "title" }), View.spacer(),
      View.text(toast && toast.until > Date.now() ? toast.text : items.length + " items", { style: "caption", color: "gray" })])
  ].concat(rows), { spacing: 5, align: "leading" }), { amount: 8 });
}

function fullExpandedView() {
  var rows = error ? [View.text(error, { style: "caption", color: "orange" })]
    : items.slice(0, 50).map(function (i) { return itemRow(i, 60); });
  return View.padding(View.vstack([
    View.hstack([View.text("Clipboard Shelf", { style: "title" }), View.spacer(),
      View.button(View.text("Clear unpinned", { style: "caption", color: "red" }), "clear")]),
    View.scroll(View.vstack(rows, { spacing: 6, align: "leading" }), { axes: "vertical" })
  ], { spacing: 8, align: "leading" }), { amount: 10 });
}

function start() { refresh(); if (timerID === null) timerID = setInterval(refresh, 1500); }

SuperIsland.registerModule({
  onActivate: start,
  onDeactivate: function () { if (timerID !== null) { clearInterval(timerID); timerID = null; } },
  onAction: function (id) {
    if (id === "clear") { call("POST", "/clipboard/clear").then(refresh); return; }
    var m = /^(copy|pin|del):(\d+)$/.exec(id);
    if (!m) return;
    var path = { copy: "/clipboard/copy", pin: "/clipboard/pin", del: "/clipboard/delete" }[m[1]];
    call("POST", path, { id: Number(m[2]) }).then(function (r) {
      if (m[1] === "copy") {
        toast = { text: r.ok ? "Copied!" : "Copy failed", until: Date.now() + 1800 };
        SuperIsland.playFeedback(r.ok ? "success" : "error");
      }
      refresh();
    });
  },
  compact: compactView,
  expanded: expandedView,
  fullExpanded: fullExpandedView
});

start();
