"use strict";

// GitLab — MRs to review, your open MRs (with head pipeline status), failed
// pipelines. Needs the VPN when the instance is internal.

var state = { review: [], mine: [], todos: [], issues: [], error: null, loading: false, at: 0 };
var activeTab = "review";
var known = null;        // { reviewIDs:{}, pipelines:{} } — baseline for notifications
var timerID = null;

function setting(k, d) { var v = SuperIsland.settings.get(k); return v === null || v === undefined || v === "" ? d : v; }
function base() { return String(setting("baseUrl", "https://gitlab.lbd.udc.es")).replace(/\/+$/, ""); }
function token() { return String(setting("token", "")).trim(); }

function api(path, method) {
  return SuperIsland.http.fetch(base() + "/api/v4" + path, {
    method: method || "GET", headers: { "PRIVATE-TOKEN": token() }
  }).then(function (res) {
    if (res.error) throw new Error(res.error);
    if (res.status === 401) throw new Error("Invalid token");
    if (res.status >= 400) throw new Error("HTTP " + res.status);
    return res.data || (res.text ? JSON.parse(res.text) : null);
  });
}

function notify(title, body, url) {
  if (!setting("notify", true)) return;
  SuperIsland.notifications.send({ title: title, body: body, sound: false, appName: "GitLab" });
}

function normalize(mr) {
  var p = mr.head_pipeline || null;
  return {
    id: mr.id, iid: mr.iid, project: (mr.references && mr.references.full) ? mr.references.full.replace(/!\d+$/, "") : String(mr.project_id),
    title: mr.title, url: mr.web_url, author: mr.author && mr.author.name, draft: !!(mr.draft || mr.work_in_progress),
    pipeline: p ? p.status : null, pipelineID: p ? p.id : null, projectID: mr.project_id,
    conflicts: !!mr.has_conflicts, updated: mr.updated_at
  };
}

function refresh() {
  if (!token()) { state.error = "Set your GitLab token in Settings → Extensions → GitLab"; return; }
  if (state.loading) return;
  state.loading = true;
  Promise.all([
    api("/merge_requests?scope=all&state=opened&reviewer_username=" + encodeURIComponent(username) + "&per_page=30"),
    api("/merge_requests?scope=created_by_me&state=opened&per_page=30"),
    api("/todos?state=pending&per_page=30").catch(function () { return []; }),
    api("/issues?scope=assigned_to_me&state=opened&per_page=30").catch(function () { return []; })
  ]).then(function (r) {
    state.todos = (r[2] || []).map(function (t) {
      return { id: t.id, action: String(t.action_name || "").replace(/_/g, " "), title: t.target && t.target.title || t.body,
               project: t.project && t.project.path_with_namespace, url: t.target_url, who: t.author && t.author.name };
    });
    state.issues = (r[3] || []).map(function (i) {
      return { id: i.id, title: i.title, project: i.references && i.references.full ? i.references.full.replace(/#\d+$/, "") : "", url: i.web_url,
               labels: (i.labels || []).slice(0, 2).join(", ") };
    });
    state.review = (r[0] || []).map(normalize);
    state.mine = (r[1] || []).map(normalize);
    state.error = null; state.at = Date.now();
    diff();
  }).catch(function (e) { state.error = e.message; }).then(function () { state.loading = false; });
}

var username = "";
function init() {
  if (!token()) return refresh();
  api("/user").then(function (u) { username = u.username; refresh(); }).catch(function (e) { state.error = e.message; });
}

function diff() {
  var reviewIDs = {}, pipelines = {};
  state.review.forEach(function (m) { reviewIDs[m.id] = true; });
  state.mine.forEach(function (m) { pipelines[m.id] = m.pipeline; });
  if (known) {
    state.review.forEach(function (m) {
      if (!known.reviewIDs[m.id]) {
        notify("Review requested", m.project + " · " + m.title);
        SuperIsland.playFeedback("selection");
        SuperIsland.island.activate(true);
      }
    });
    state.mine.forEach(function (m) {
      var before = known.pipelines[m.id];
      if (before && before !== m.pipeline && (m.pipeline === "failed" || m.pipeline === "success")) {
        notify("Pipeline " + m.pipeline, m.project + " · " + m.title);
        SuperIsland.playFeedback(m.pipeline === "failed" ? "error" : "success");
        SuperIsland.island.activate(true);
      }
    });
  }
  known = { reviewIDs: reviewIDs, pipelines: pipelines };
}

function pipeColor(s) {
  return { success: "green", failed: "red", running: "yellow", pending: "orange", canceled: "gray" }[s] || "gray";
}

function mrRow(m) {
  return View.hstack([
    View.button(View.hstack([
      View.icon("circle.fill", { size: 8, color: pipeColor(m.pipeline) }),
      View.vstack([
        View.text((m.draft ? "[Draft] " : "") + m.title, { style: "body", lineLimit: 1 }),
        View.text(m.project + (m.author ? " · " + m.author : "") + (m.conflicts ? " · conflicts" : ""), { style: "caption", color: "gray", lineLimit: 1 })
      ], { spacing: 1, align: "leading" })
    ], { spacing: 8, align: "center" }), "open:" + m.id),
    View.spacer(),
    m.pipeline === "failed" ? View.button(View.icon("arrow.clockwise", { size: 11, color: "orange" }), "retry:" + m.id) : null
  ], { spacing: 8, align: "center" });
}

function simpleRow(prefix, id, title, sub, extra) {
  return View.hstack([
    View.button(View.vstack([
      View.text(title, { style: "body", lineLimit: 1 }),
      View.text(sub, { style: "caption", color: "gray", lineLimit: 1 })
    ], { spacing: 1, align: "leading" }), "open" + prefix + ":" + id),
    View.spacer(),
    extra || null
  ], { spacing: 8, align: "center" });
}

function list() { return activeTab === "review" ? state.review : state.mine; }

function tabs() {
  function t(id, label, n) {
    return View.button(View.text(label + " " + n, { style: "caption", color: activeTab === id ? "white" : "gray" }), "tab:" + id);
  }
  return View.hstack([t("review", "Review", state.review.length), t("mine", "Mine", state.mine.length), t("todos", "Todos", state.todos.length), t("issues", "Issues", state.issues.length)], { spacing: 10 });
}

function bodyRows(limit) {
  if (state.error) return [View.text(state.error, { style: "caption", color: "orange", lineLimit: 3 })];
  if (activeTab === "todos") {
    if (state.todos.length === 0) return [View.text("Inbox zero 🎉", { style: "caption", color: "gray" })];
    return state.todos.slice(0, limit).map(function (t) {
      return simpleRow("t", t.id, t.title, t.action + " · " + (t.project || "") + (t.who ? " · " + t.who : ""),
        View.button(View.icon("checkmark.circle", { size: 12, color: "green" }), "done:" + t.id));
    });
  }
  if (activeTab === "issues") {
    if (state.issues.length === 0) return [View.text("No assigned issues", { style: "caption", color: "gray" })];
    return state.issues.slice(0, limit).map(function (i) {
      return simpleRow("i", i.id, i.title, i.project + (i.labels ? " · " + i.labels : ""));
    });
  }
  var l = list();
  if (l.length === 0) return [View.text(state.at ? "Nothing here 🎉" : "Loading…", { style: "caption", color: "gray" })];
  return l.slice(0, limit).map(mrRow);
}

function compactView() {
  var failed = state.mine.filter(function (m) { return m.pipeline === "failed"; }).length;
  return View.hstack([
    View.icon("arrow.triangle.merge", { size: 12, color: failed ? "red" : "orange" }),
    View.spacer(),
    View.text(state.error ? "!" : state.review.length + " to review" + (state.todos.length ? " · " + state.todos.length + " todo" : "") + (failed ? " · " + failed + " ✗" : ""), { style: "caption", lineLimit: 1 })
  ], { spacing: 6, align: "center" });
}

function expandedView() {
  return View.padding(View.vstack([
    View.hstack([View.text("GitLab", { style: "title" }), View.spacer(), tabs(),
      View.button(View.icon("arrow.clockwise", { size: 11, color: "gray" }), "refresh")], { spacing: 10 })
  ].concat(bodyRows(3)), { spacing: 5, align: "leading" }), { amount: 8 });
}

function fullExpandedView() {
  return View.padding(View.vstack([
    View.hstack([View.text("GitLab", { style: "title" }), View.spacer(), tabs(),
      View.button(View.icon("arrow.clockwise", { size: 11, color: "gray" }), "refresh")], { spacing: 10 }),
    View.scroll(View.vstack(bodyRows(30), { spacing: 6, align: "leading" }), { axes: "vertical" })
  ], { spacing: 8, align: "leading" }), { amount: 10 });
}

function start() {
  init();
  if (timerID === null) timerID = setInterval(function () { username ? refresh() : init(); },
    (Number(setting("pollSeconds", "120")) || 120) * 1000);
}

SuperIsland.registerModule({
  onActivate: start,
  onDeactivate: function () { if (timerID !== null) { clearInterval(timerID); timerID = null; } },
  onAction: function (id) {
    if (id === "refresh") { state.loading = false; username ? refresh() : init(); return; }
    if (id.indexOf("tab:") === 0) { activeTab = id.slice(4); SuperIsland.playFeedback("selection"); return; }
    var tm = /^(opent|openi|done):(\d+)$/.exec(id);
    if (tm) {
      var n = Number(tm[2]);
      if (tm[1] === "opent" || tm[1] === "openi") {
        var o = (tm[1] === "opent" ? state.todos : state.issues).filter(function (x) { return x.id === n; })[0];
        if (o && o.url) SuperIsland.openURL(o.url);
      } else {
        api("/todos/" + n + "/mark_as_done", "POST").then(function () {
          state.todos = state.todos.filter(function (x) { return x.id !== n; });
          SuperIsland.playFeedback("success");
        }).catch(function (e) { state.error = "Could not mark done: " + e.message; });
      }
      return;
    }
    var m = /^(open|retry):(\d+)$/.exec(id);
    if (!m) return;
    var mr = state.review.concat(state.mine).filter(function (x) { return x.id === Number(m[2]); })[0];
    if (!mr) return;
    if (m[1] === "open") { SuperIsland.openURL(mr.url); return; }
    api("/projects/" + mr.projectID + "/pipelines/" + mr.pipelineID + "/retry", "POST")
      .then(function () { SuperIsland.playFeedback("success"); setTimeout(refresh, 2000); })
      .catch(function (e) { state.error = "Retry failed: " + e.message; SuperIsland.playFeedback("error"); });
  },
  compact: compactView,
  expanded: expandedView,
  fullExpanded: fullExpandedView
});

start();
