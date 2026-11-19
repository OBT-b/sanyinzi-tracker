/* 對 data.json 套用操作。需與桌面版 store.py 的 apply_op 保持一致；可重複套用（冪等）。 */
(function () {
  "use strict";

  function findIdx(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  function applyOp(doc, op) {
    doc.positions = doc.positions || [];
    doc.closed = doc.closed || [];
    doc.settings = doc.settings || {};
    var id = op.id != null ? op.id : (op.pos && op.pos.id);
    var i = findIdx(doc.positions, id);
    switch (op.op) {
      case "add_pos":
        if (i < 0 && findIdx(doc.closed, id) < 0) doc.positions.push(op.pos);
        break;
      case "update_pos":
        if (i >= 0) doc.positions[i] = Object.assign({}, op.pos, { id: op.id });
        break;
      case "delete_pos":
        if (i >= 0) doc.positions.splice(i, 1);
        break;
      case "close_pos":
        if (i >= 0) {
          var p = doc.positions.splice(i, 1)[0];
          doc.closed.push(Object.assign({}, p, {
            exit_date: op.exit_date, exit_price: op.exit_price, reason: op.reason || ""
          }));
        }
        break;
      case "delete_closed":
        var j = findIdx(doc.closed, op.id);
        if (j >= 0) doc.closed.splice(j, 1);
        break;
      case "save_settings":
        Object.keys(op.values).forEach(function (k) { doc.settings[k] = String(op.values[k]); });
        break;
      default:
        throw new Error("未知的操作：" + op.op);
    }
    return doc;
  }

  /** 台股費用：手續費 0.1425%（單邊）、證交稅 0.3%（賣出）。折扣不計，僅供估算。 */
  var FEE = 0.001425, TAX = 0.003;
  function realized(c) {
    var cost = c.entry_price * c.shares, proceeds = c.exit_price * c.shares;
    var net = proceeds * (1 - FEE - TAX) - cost * (1 + FEE);
    return { net: net, pct: cost ? net / (cost * (1 + FEE)) * 100 : null };
  }

  window.Calc = { applyOp: applyOp, realized: realized };
})();
