/* 三因子選股 — 網頁版 UI。操作邏輯在 calc.js，GitHub 存取在 github.js。 */
(function () {
  "use strict";
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var state = { gh: null, doc: null, signals: null, status: null, editingId: null, polling: false };
  var AUTO_RELOAD_MS = 5 * 60 * 1000;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(v, d) { return Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d }); }
  function money(v) { return v == null ? "—" : fmt(Math.round(v) || 0, 0); }
  function signed(v) { if (v == null) return "—"; var r = Math.round(v) || 0; return (r >= 0 ? "+" : "-") + fmt(Math.abs(r), 0); }
  function pct(v) { return v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; }
  function cls(v) { return v == null || Math.abs(v) < 0.005 ? "" : (v > 0 ? "up" : "down"); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function todayStr() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }

  var toastTimer;
  function toast(msg, isError) {
    var t = $("#toast");
    t.textContent = msg; t.className = "toast" + (isError ? " error" : ""); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3000);
  }
  function errMsg(e) {
    if (e && e.status === 401) return "權杖無效或已過期，請登出後重新輸入";
    if (e && e.status === 403) return "權杖權限不足（需要 Contents 與 Actions 的讀寫權限）";
    if (e && e.status === 404) return "找不到資料 repo，或權杖沒有存取這個 repo 的權限";
    return (e && e.message) || String(e);
  }

  // ------------------------------------------------------------------ 連線
  function showSetup(error) {
    $("#main").hidden = true; $("#setup").hidden = false;
    $("#setup-error").textContent = error || "";
    var cfg = GitHubStore.loadConfig(), f = $("#setup-form");
    if (cfg) { f.elements.owner.value = cfg.owner; f.elements.repo.value = cfg.repo; }
  }

  function connect(cfg) {
    state.gh = new GitHubStore.GitHub(cfg);
    return state.gh.check().then(loadAll).then(function () {
      $("#setup").hidden = true; $("#main").hidden = false;
      GitHubStore.saveConfig(cfg);
    });
  }

  function loadAll() {
    var gh = state.gh;
    return Promise.all([gh.readJson("data.json"), gh.readJson("signals.json"), gh.readJson("status.json")])
      .then(function (r) {
        if (!r[0].data) throw new Error("資料 repo 中找不到 data.json");
        state.doc = r[0].data; state.signals = r[1].data; state.status = r[2].data;
        $("#sync-status").textContent = "已同步 " + pad(new Date().getHours()) + ":" + pad(new Date().getMinutes());
        render();
      });
  }

  /** 觸發 workflow，輪詢 signals.json 的 generated_at 直到更新（最多約 6 分鐘；首次建置資料要更久，之後可手動重新整理）。 */
  function updateSignals() {
    if (state.polling) return;
    state.polling = true;
    $("#btn-update").disabled = true;
    var before = state.signals && state.signals.generated_at, tries = 0;
    function finish(msg, isErr) { state.polling = false; $("#btn-update").disabled = false; toast(msg, isErr); }
    state.gh.dispatchUpdate().then(function () {
      toast("已觸發更新，約需 1～3 分鐘（首次需數十分鐘）");
      (function poll() {
        setTimeout(function () {
          tries++;
          state.gh.readJson("signals.json").then(function (r) {
            if (r.data && r.data.generated_at !== before) {
              return loadAll().then(function () { finish("訊號已更新"); });
            }
            if (tries >= 24) finish("尚未完成，稍後請按「重新整理」", true); else poll();
          }, function () { if (tries >= 24) finish("讀取失敗", true); else poll(); });
        }, 15000);
      })();
    }, function (e) { finish(errMsg(e), true); });
  }

  function commit(ops, message) {
    return state.gh.commitOps(ops, message).then(function (r) {
      state.doc = r.data; render();
      // 持股變動後 workflow 會自動重算；稍後重讀 status.json
      setTimeout(function () { state.gh.readJson("status.json").then(function (s) { state.status = s.data; render(); }); }, 45000);
    });
  }

  // ------------------------------------------------------------------ 畫面
  function heldIds() { var m = {}; (state.doc.positions || []).forEach(function (p) { m[p.stock_id] = 1; }); return m; }

  function renderSignals() {
    var s = state.signals, held = heldIds();
    if (!s) {
      $("#sig-cards").innerHTML = "";
      $("#sig-table tbody").innerHTML = '<tr><td colspan="9" class="muted">尚無訊號資料，請按「更新訊號」。</td></tr>';
      $("#sig-status").textContent = "";
      return;
    }
    $("#sig-cards").innerHTML =
      card("訊號日", s.trade_date, "下一交易日尾盤進場") +
      card("符合檔數", s.signals.length, "掃描 " + s.universe + " 檔") +
      card("每檔投入", money(s.capital_per_trade), "更新於 " + s.generated_at);
    $("#sig-status").textContent = "更新於 " + s.generated_at;
    $("#sig-table tbody").innerHTML = s.signals.length ? s.signals.map(function (r) {
      return "<tr><td>" + esc(r.stock_id) + (held[r.stock_id] ? ' <span class="muted small">已持有</span>' : "") + "</td>" +
        '<td class="num">' + fmt(r.close, 2) + '</td><td class="num">' + fmt(r.ma20, 2) + "</td>" +
        '<td class="num">' + pct(r.dist_ma20) + '</td><td class="num">' + fmt(r.bbw, 2) + "</td>" +
        '<td class="num">' + r.hist + '</td><td class="num">' + fmt(r.turnover, 2) + "</td>" +
        '<td class="num">' + fmt(r.shares, 0) + '</td><td><button class="link" data-buy="' + esc(r.stock_id) + '">記錄買進</button></td></tr>';
    }).join("") : '<tr><td colspan="9" class="muted">今日無符合條件股票</td></tr>';
  }

  function card(title, value, sub) {
    return '<div class="card"><div class="card-title">' + esc(title) + '</div><div class="card-value">' + esc(value) +
      '</div><div class="card-sub muted small">' + esc(sub || "") + "</div></div>";
  }

  function renderPositions() {
    var st = {}, d = state.status;
    ((d && d.positions) || []).forEach(function (r) { st[r.id] = r; });
    var totalPnl = 0, totalCost = 0, rows = (state.doc.positions || []).map(function (p) {
      var r = st[p.id], pnlAmt = null;
      if (r && r.close != null) { pnlAmt = (r.close - p.entry_price) * p.shares; totalPnl += pnlAmt; }
      totalCost += p.entry_price * p.shares;
      var act = r ? '<span class="' + (r.level === "exit" ? "up" : r.level === "warn" ? "warn" : "") + '">' + esc(r.action) + "</span>"
                  : '<span class="muted">待更新</span>';
      return "<tr><td>" + esc(p.stock_id) + "</td><td>" + esc(p.entry_date) + '</td><td class="num">' + fmt(p.entry_price, 2) +
        '</td><td class="num">' + fmt(p.shares, 0) + '</td><td class="num">' + (r && r.close != null ? fmt(r.close, 2) : "—") +
        '</td><td class="num">' + (r && r.ma20 != null ? fmt(r.ma20, 2) : "—") + '</td><td class="num ' + cls(r && r.pnl) + '">' +
        (r && r.pnl != null ? pct(r.pnl) : "—") + '</td><td class="num ' + cls(pnlAmt) + '">' + signed(pnlAmt) + "</td><td>" + act +
        '</td><td><button class="link" data-close="' + esc(p.id) + '">出場</button><button class="link" data-edit="' + esc(p.id) +
        '">修改</button><button class="link" data-del="' + esc(p.id) + '">刪除</button></td></tr>';
    });
    $("#pos-table tbody").innerHTML = rows.length ? rows.join("") : '<tr><td colspan="10" class="muted">目前沒有持股</td></tr>';
    $("#pos-cards").innerHTML = card("持股檔數", (state.doc.positions || []).length, "成本 " + money(totalCost)) +
      card("未實現損益(元)", signed(totalPnl), "未扣費用");
    $("#pos-status").textContent = d ? "資料日 " + d.trade_date + "（更新於 " + d.generated_at + "）" : "";
    var exits = ((d && d.positions) || []).filter(function (r) { return r.level === "exit"; });
    if (exits.length) $("#pos-status").innerHTML += ' <b class="up">' + exits.length + " 檔需出場</b>";
  }

  function renderClosed() {
    var sum = 0;
    var rows = (state.doc.closed || []).slice().sort(function (a, b) { return a.exit_date < b.exit_date ? 1 : -1; }).map(function (c) {
      var r = Calc.realized(c); sum += r.net;
      return "<tr><td>" + esc(c.stock_id) + "</td><td>" + esc(c.entry_date) + '</td><td class="num">' + fmt(c.entry_price, 2) +
        "</td><td>" + esc(c.exit_date) + '</td><td class="num">' + fmt(c.exit_price, 2) + '</td><td class="num">' + fmt(c.shares, 0) +
        '</td><td class="num ' + cls(r.net) + '">' + signed(r.net) + '</td><td class="num ' + cls(r.pct) + '">' + pct(r.pct) +
        "</td><td>" + esc(c.reason) + '</td><td><button class="link" data-delclosed="' + esc(c.id) + '">刪除</button></td></tr>';
    });
    $("#closed-table tbody").innerHTML = rows.length ? rows.join("") : '<tr><td colspan="10" class="muted">尚無出場紀錄</td></tr>';
    $("#closed-sum").textContent = rows.length ? "合計 " + signed(sum) + " 元" : "";
  }

  function renderSettings() {
    var f = $("#set-form");
    if (document.activeElement !== f.elements.capital_per_trade) f.elements.capital_per_trade.value = state.doc.settings.capital_per_trade || "100000";
    var r = (state.signals && state.signals.rules) || (state.status && state.status.rules);
    $("#rules").innerHTML = r ? "出場：收盤連續 " + r.exit_below_days + " 日低於 MA20，或跌破進場價 " + r.stop_loss_pct +
      "% → 隔天開盤賣出。<br>進場：成交金額 ≥ " + r.min_turnover_yi + " 億；股票池為近 20 日均成交金額前 " + r.universe_top_n + " 名普通股。<br>（規則在資料 repo 的 scripts/config.py 修改）" : "";
  }

  function render() { renderSignals(); renderPositions(); renderClosed(); renderSettings(); }

  // ------------------------------------------------------------------ 表單
  function clearPosForm() {
    var f = $("#pos-form"); f.reset(); state.editingId = null;
    f.elements.entry_date.value = todayStr();
    $("#pos-form-title").textContent = "新增持股"; $("#btn-save-pos").textContent = "新增";
  }

  function fillPosForm(vals) {
    var f = $("#pos-form");
    Object.keys(vals).forEach(function (k) { f.elements[k].value = vals[k]; });
  }

  function onPosSubmit(e) {
    e.preventDefault();
    var f = e.target.elements, id = state.editingId;
    var pos = {
      id: id || uuid(), stock_id: f.stock_id.value.trim(), entry_date: f.entry_date.value,
      entry_price: parseFloat(f.entry_price.value), shares: parseInt(f.shares.value, 10), note: f.note.value.trim()
    };
    if (!/^\d{4}$/.test(pos.stock_id)) return toast("代號需為 4 位數字", true);
    if (!(pos.entry_price > 0) || !(pos.shares > 0)) return toast("進場價與股數需大於 0", true);
    var op = id ? { op: "update_pos", id: id, pos: pos } : { op: "add_pos", pos: pos };
    commit([op], "網頁版：" + (id ? "修改持股 " : "新增持股 ") + pos.stock_id).then(function () {
      toast(id ? "已修改" : "已新增"); clearPosForm();
    }, function (err) { toast(errMsg(err), true); });
  }

  function findPos(id) { return (state.doc.positions || []).filter(function (p) { return p.id === id; })[0]; }

  function onTableClick(e) {
    var b = e.target.closest("button"); if (!b) return;
    if (b.dataset.buy) {
      var r = state.signals.signals.filter(function (x) { return x.stock_id === b.dataset.buy; })[0];
      switchTab("pos"); clearPosForm();
      fillPosForm({ stock_id: r.stock_id, entry_price: r.close, shares: r.shares });
      toast("已帶入收盤價與建議股數，請改成實際成交價後新增");
    } else if (b.dataset.edit) {
      var p = findPos(b.dataset.edit); state.editingId = p.id;
      fillPosForm({ stock_id: p.stock_id, entry_date: p.entry_date, entry_price: p.entry_price, shares: p.shares, note: p.note || "" });
      $("#pos-form-title").textContent = "修改持股"; $("#btn-save-pos").textContent = "儲存";
      window.scrollTo(0, 0);
    } else if (b.dataset.del) {
      if (confirm("刪除這筆持股？（不會留下出場紀錄）")) commit([{ op: "delete_pos", id: b.dataset.del }], "網頁版：刪除持股").catch(function (err) { toast(errMsg(err), true); });
    } else if (b.dataset.close) {
      var q = findPos(b.dataset.close), st = ((state.status && state.status.positions) || []).filter(function (x) { return x.id === q.id; })[0];
      var price = prompt("出場價（" + q.stock_id + "）", st && st.close != null ? st.close : "");
      if (price === null) return;
      price = parseFloat(price);
      if (!(price > 0)) return toast("出場價需大於 0", true);
      var reason = st && st.level === "exit" ? (st.action.indexOf("停損") === 0 ? "停損" : "跌破月線") : "手動出場";
      commit([{ op: "close_pos", id: q.id, exit_date: todayStr(), exit_price: price, reason: reason }], "網頁版：出場 " + q.stock_id)
        .then(function () { toast("已移到「已結束」"); }, function (err) { toast(errMsg(err), true); });
    } else if (b.dataset.delclosed) {
      if (confirm("刪除這筆出場紀錄？")) commit([{ op: "delete_closed", id: b.dataset.delclosed }], "網頁版：刪除出場紀錄").catch(function (err) { toast(errMsg(err), true); });
    }
  }

  function switchTab(name) {
    $$(".tabs button").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === name); });
    $$(".tab").forEach(function (t) { t.classList.toggle("active", t.id === "tab-" + name); });
  }

  // ------------------------------------------------------------------ 啟動
  $$(".tabs button").forEach(function (b) { b.addEventListener("click", function () { switchTab(b.dataset.tab); }); });
  $("#pos-form").addEventListener("submit", onPosSubmit);
  $("#btn-clear-pos").addEventListener("click", clearPosForm);
  ["#sig-table", "#pos-table", "#closed-table"].forEach(function (s) { $(s).addEventListener("click", onTableClick); });
  $("#set-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = parseInt(e.target.elements.capital_per_trade.value, 10);
    if (!(v > 0)) return toast("金額需大於 0", true);
    commit([{ op: "save_settings", values: { capital_per_trade: v } }], "網頁版：修改每檔投入金額")
      .then(function () { toast("已儲存，雲端將重新計算"); }, function (err) { toast(errMsg(err), true); });
  });
  $("#btn-update").addEventListener("click", updateSignals);
  $("#btn-reload").addEventListener("click", function () { loadAll().then(function () { toast("已重新整理"); }, function (e) { toast(errMsg(e), true); }); });
  $("#btn-logout").addEventListener("click", function () { GitHubStore.clearConfig(); state.gh = null; showSetup(); });
  $("#setup-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target.elements;
    connect({ owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() })
      .catch(function (err) { $("#setup-error").textContent = errMsg(err); });
  });

  setInterval(function () { if (state.gh && !$("#main").hidden && !document.hidden) loadAll().catch(function () {}); }, AUTO_RELOAD_MS);

  clearPosForm();
  var cfg = GitHubStore.loadConfig();
  if (cfg && cfg.token) connect(cfg).catch(function (e) { showSetup(errMsg(e)); }); else showSetup();
})();
