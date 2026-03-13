// tables.js

function convertTablesToHubLModules(html) {
  html = applyTableNameMarkers(html);

  const result = insertTablePlaceholders(html);
  const htmlWithPlaceholders = result.htmlWithPlaceholders;
  const placeholders = result.placeholders;

  if (!placeholders.length) return html;

  const converted = placeholders.map(function (ph) {
    return {
      id: ph.id,
      hubl: convertTableHtmlToHubL(ph.tableHtml)
    };
  });

  return replaceTablePlaceholders(htmlWithPlaceholders, converted);
}

function applyTableNameMarkers(html) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(html || "", "text/html");

  var tables = Array.from(doc.querySelectorAll("table"));

  tables.forEach(function (table) {
    var prev = table.previousSibling;

    while (prev && isIgnorableBetweenTnAndTable(prev)) {
      prev = prev.previousSibling;
    }

    if (!prev || prev.nodeType !== 1) return;

    if (prev.tagName && prev.tagName.toLowerCase() === "p") {
      var text = (prev.textContent || "").trim();

      if (/\[tn\]/i.test(text)) {
        var name = text
          .replace(/\s*\[tn\]\s*/gi, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (name) {
          table.setAttribute("data-tablename", name);
        }

        prev.parentNode.removeChild(prev);
      }
    }
  });

  return doc.body ? doc.body.innerHTML : html;
}

function isIgnorableBetweenTnAndTable(node) {
  if (node.nodeType === 3) {
    return !(node.nodeValue || "").trim();
  }

  if (node.nodeType === 1 && node.tagName && node.tagName.toLowerCase() === "p") {
    var text = (node.textContent || "").replace(/\u00a0/g, " ").trim();
    if (text) return false;

    if (node.querySelector && node.querySelector("img, svg, video, iframe")) {
      return false;
    }

    return true;
  }

  return false;
}

function insertTablePlaceholders(html) {
  const tableRegex = /<table[\s\S]*?<\/table>/gi;

  var placeholders = [];
  var index = 0;

  var htmlWithPlaceholders = html.replace(tableRegex, function (match) {
    var id = "__HUBL_TABLE_" + index + "__";
    placeholders.push({
      id: id,
      tableHtml: match
    });
    index++;
    return id;
  });

  return {
    htmlWithPlaceholders: htmlWithPlaceholders,
    placeholders: placeholders
  };
}

function replaceTablePlaceholders(html, convertedPlaceholders) {
  var out = html;

  convertedPlaceholders.forEach(function (ph) {
    var wrapped = "\n" + ph.hubl + "\n";
    out = out.split(ph.id).join(wrapped);
  });

  return out;
}

function convertTableHtmlToHubL(tableHtml) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(tableHtml, "text/html");
  var table = doc.querySelector("table");

  if (!table) return tableHtml;

  var model = parseTableToModel(table);
  if (!model) return tableHtml;

  return renderHubLTableModule(model);
}

function parseTableToModel(table) {
  var rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return null;

  var headerCells = Array.from(rows[0].querySelectorAll("td"));
  if (headerCells.length < 2) return null;

  var totalCols = headerCells.length;

  var columns = headerCells.slice(1).map(function (td) {
    return (td.textContent || "").trim();
  });

  var outRows = [];

  for (var i = 1; i < rows.length; i++) {
    var tds = Array.from(rows[i].querySelectorAll("td"));
    if (!tds.length) continue;

    if (tds.length === 1) {
      var colspan = parseInt(tds[0].getAttribute("colspan") || "1", 10);

      if (colspan >= totalCols) {
        outRows.push({
          rowType: "sectionHeaderRow",
          header: (tds[0].textContent || "").trim(),
          cells: { icon: "none" }
        });
        continue;
      }
    }

    var rowLabel = cleanCellHtml(tds[0].innerHTML);

    var cells = columns.map(function (_, colIndex) {
      var td = tds[colIndex + 1];

      return {
        icon: "none",
        text: td ? cleanCellHtml(td.innerHTML) : "<p></p>"
      };
    });

    outRows.push({
      rowType: "dataRow",
      row_label: rowLabel,
      cells: cells
    });
  }

  var tableName = (table.getAttribute("data-tablename") || "").trim();

  return {
    tableName: tableName,
    columns: columns,
    rows: outRows
  };
}

function cleanCellHtml(html) {
  var container = document.createElement("div");
  container.innerHTML = html || "";

  var walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  var nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  nodes.forEach(function (el) {
    var tag = el.tagName.toLowerCase();
    var keepAttrs = tag === "a" ? ["href"] : [];

    Array.from(el.attributes).forEach(function (attr) {
      if (!keepAttrs.includes(attr.name.toLowerCase())) {
        el.removeAttribute(attr.name);
      }
    });

    if (tag === "span") {
      var parent = el.parentNode;
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      parent.removeChild(el);
    }
  });

  var cleaned = container.innerHTML.trim();
  var textOnly = cleaned.replace(/<[^>]*>/g, "").trim();

  return textOnly ? cleaned : "<p></p>";
}

function renderHubLTableModule(model) {
  var out =
    '{% module "table"\n' +
    '  unique_in_loop=True,\n' +
    '  style={ "theme": "white" },\n' +
    '  path="/_Web Team Assets/Component Modules/modules/table",\n' +
    '  label="table",\n';

  if (model.tableName && model.tableName.trim()) {
    out += '  tableName="' +
      model.tableName.replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
      '",\n';
  }

  out +=
    '  columns=' + renderHubLValue(model.columns, 1) + ',\n' +
    '  rows=' + renderHubLValue(model.rows, 1) + '\n' +
    '%}';

  return out;
}

function renderHubLValue(value, indentLevel) {
  indentLevel = indentLevel || 0;

  var indent = "  ".repeat(indentLevel);
  var nextIndent = "  ".repeat(indentLevel + 1);

  if (Array.isArray(value)) {
    if (!value.length) return "[]";

    return "[\n" +
      value.map(function (v) {
        return nextIndent + renderHubLValue(v, indentLevel + 1);
      }).join(",\n") +
      "\n" + indent + "]";
  }

  if (value && typeof value === "object") {
    var entries = Object.entries(value);

    if (!entries.length) return "{}";

    return "{\n" +
      entries.map(function (entry) {
        var key = entry[0];
        var val = entry[1];
        return nextIndent + key + ": " +
          renderHubLValue(val, indentLevel + 1);
      }).join(",\n") +
      "\n" + indent + "}";
  }

  if (typeof value === "string") {
    var escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    return '"' + escaped + '"';
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value === null || value === undefined) {
    return "null";
  }

  return String(value);
}