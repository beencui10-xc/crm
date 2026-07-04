/* ============================================================
   Customer Follow-up Management System — Web Edition
   Pure client-side. Replicates image_HSI... no, replicates
   Customers_follow-up_management_system_Va.py functionality.
   Data model mirrors the Excel layout:
     Sheet1 = customer master (one row per customer)
     Contacts = serialized string with <Key:Value> tags, one block per contact
     config = rating offsets + dropdown option lists
   Storage: in-memory + localStorage backup. Import/export via SheetJS.
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     CONSTANTS & DEFAULT CONFIG
     ============================================================ */
  const CUSTOMER_COLUMNS = [
    "Index", "ID", "Contacts", "Rating", "Set", "Last", "Next",
    "Address", "Company", "Website", "Category", "Region", "From", "Log"
  ];
  const CONTACT_COLUMNS = ["Type", "Contact", "Name", "Status", "Com_Last", "Com_Records"];

  const DEFAULT_CONFIG = {
    ratingOffset: { "普通": 30, "关注": 15, "重要": 7, "忽略": 300, "无效": 600, "待开发": 150, "全部": 0 },
    ratingList: ["普通", "关注", "重要", "忽略", "无效", "待开发", "全部"],
    categoryList: ["塑料", "金属", "回收", "玻璃", "橡胶", "矿石", "PET", "铝", "石英", "电子产品", "电路板", "全部"],
    regionList: ["澳大利亚", "肯尼亚", "南非", "美国", "新加坡", "厄瓜多尔", "巴西", "印度", "意大利", "苏丹", "俄罗斯", "墨西哥", "英国", "阿联酋", "土耳其", "全部"],
    fromList: ["网络", "询盘", "展会", "Facebook", "主动消息", "分配", "介绍", "搜索引擎"],
    contactTypeList: ["Email", "Phone", "WhatsApp", "Twitter", "Instagram", "FaceBook", "Website", "LinkedIn", "TikTok", "Wechat", "Others"],
    contactStatusList: ["Active", "Bounce", "Deactivated", "Removed"],
  };

  const STORAGE_KEY = "cfms_data_v1";
  const CONFIG_KEY = "cfms_config_v1";

  /* ============================================================
     STATE
     ============================================================ */
  const state = {
    customers: [],          // array of customer objects (see normalizeCustomer)
    currentIdx: -1,         // index into state.customers
    filteredIdx: [],        // indices of filtered customers
    filterPage: 0,          // pointer into filteredIdx
    config: loadConfig(),
    dirty: false,
    fileName: "",
  };

  function loadConfig() {
    try {
      const saved = localStorage.getItem(CONFIG_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)); } catch (e) {}
  }

  /* ============================================================
     UTILITIES
     ============================================================ */
  const $ = (id) => document.getElementById(id);
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const fmtDate = (v) => {
    if (!v) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(v);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
    return s;
  };
  const parseDate = (v) => {
    if (!v) return null;
    if (v instanceof Date) return v;
    const s = String(v).slice(0, 10);
    const d = new Date(s);
    return isNaN(d) ? null : d;
  };
  const addDays = (dateStr, n) => {
    const d = parseDate(dateStr) || new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const genId = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  };
  const escapeHtml = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* ============================================================
     CONTACTS SERIALIZATION  (mirrors Python <Key:Value> format)
     ============================================================ */
  function parseContactsString(str) {
    if (!str) return [];
    const cleaned = String(str).replace(/\r/g, "");
    // split on ; but the format uses ;\n between entries
    const parts = cleaned.split(/\n|;|\t/).map(s => s.trim()).filter(Boolean);
    const contacts = [];
    for (const part of parts) {
      // contact value = everything before first <
      const ltIdx = part.indexOf("<");
      let contactVal, rest;
      if (ltIdx === -1) { contactVal = part; rest = ""; }
      else { contactVal = part.slice(0, ltIdx).trim(); rest = part.slice(ltIdx); }
      const c = { Type: "", Contact: contactVal, Name: "", Status: "", Com_Last: "", Com_Records: "" };
      const re = /<([^:>]+):([^>]*)>/g;
      let m;
      while ((m = re.exec(rest)) !== null) {
        const key = m[1].trim();
        const val = m[2].trim();
        if (CONTACT_COLUMNS.includes(key)) c[key] = val === "nan" ? "" : val;
      }
      if (c.Type === "" && c.Status === "" && c.Com_Last === "" && c.Com_Records === "") {
        c.Type = "Email"; c.Status = "Active"; c.Com_Last = "2000-01-01"; c.Com_Records = "0r0";
      }
      contacts.push(c);
    }
    return contacts;
  }

  function serializeContacts(contacts) {
    if (!contacts || contacts.length === 0) return "";
    return contacts.map(c => {
      const cl = fmtDate(c.Com_Last) || "";
      return `${c.Contact}<Type:${c.Type}><Name:${c.Name}><Status:${c.Status}><Com_Last:${cl}><Com_Records:${c.Com_Records}>;`;
    }).join("\n");
  }

  /* ============================================================
     CUSTOMER NORMALIZATION & AUTO-DATES
     ============================================================ */
  function normalizeCustomer(rawRow, index) {
    const c = {};
    for (const col of CUSTOMER_COLUMNS) {
      c[col] = rawRow[col] != null ? rawRow[col] : "";
    }
    if (c.Index === "" || c.Index == null) c.Index = index + 1;
    // parse contacts
    c._contacts = parseContactsString(c.Contacts);
    // ensure ID
    if (!c.ID || String(c.ID).trim() === "") {
      c.ID = genId() + " " + (c.Region || "未知地区") + " " + (c.Category || "未知品类") + " " + (c.Company || "未知公司");
    }
    // auto dates
    autoSetDates(c);
    return c;
  }

  function autoSetDates(c) {
    const today = todayStr();
    // Set date
    if (!parseDate(c.Set)) c.Set = today;
    else c.Set = fmtDate(c.Set);

    // Last = nearest Com_Last across contacts
    let nearest = null;
    for (const ct of c._contacts) {
      const d = parseDate(ct.Com_Last);
      if (d) {
        if (!nearest || Math.abs(d - new Date()) < Math.abs(nearest - new Date())) nearest = d;
      }
    }
    c.Last = nearest ? nearest.toISOString().slice(0, 10) : "2000-01-01";

    // Next: if current Next <= today, recompute based on rating offset
    const nextDate = parseDate(c.Next);
    const rating = c.Rating || "普通";
    const offset = state.config.ratingOffset[rating] != null ? state.config.ratingOffset[rating] : 30;
    if (!nextDate || nextDate <= new Date(today)) {
      // check if any contact was contacted today or later
      const contactedToday = c._contacts.some(ct => {
        const d = parseDate(ct.Com_Last);
        return d && d >= new Date(today);
      });
      if (contactedToday) {
        c.Next = addDays(today, offset);
      } else if (!nextDate) {
        c.Next = today;
      }
      // else keep overdue date
    } else {
      c.Next = fmtDate(c.Next);
    }
  }

  function syncContactsToCustomer(c) {
    c.Contacts = serializeContacts(c._contacts);
    autoSetDates(c);
  }

  /* ============================================================
     TOAST
     ============================================================ */
  let toastTimer = null;
  function toast(msg, type) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast" + (type ? " " + type : "");
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => (el.hidden = true), 300);
    }, 2600);
  }

  /* ============================================================
     EXCEL IMPORT / EXPORT  (SheetJS)
     ============================================================ */
  function importExcel(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        const result = { customers: [], config: null, newList: [], convertList: [] };

        // Parse config sheet if present
        if (wb.SheetNames.includes("config")) {
          const ws = wb.Sheets["config"];
          const cfgArr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          result.config = parseConfigSheet(cfgArr);
        }

        // Parse Sheet1 (main customer list)
        const mainName = wb.SheetNames.find(n => /^Sheet1$/i.test(n)) || wb.SheetNames[0];
        if (mainName) {
          const ws = wb.Sheets[mainName];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
          result.customers = rows.map((r, i) => normalizeCustomer(r, i));
        }

        // Parse NewList if present
        if (wb.SheetNames.includes("NewList")) {
          const ws = wb.Sheets["NewList"];
          result.newList = XLSX.utils.sheet_to_json(ws, { defval: "" });
        }

        // Parse ConvertList if present
        if (wb.SheetNames.includes("ConvertList")) {
          const ws = wb.Sheets["ConvertList"];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          result.convertList = raw;
        }

        // Apply
        if (result.config) {
          state.config = result.config;
          saveConfig();
        }
        state.customers = result.customers;
        state._newList = result.newList;
        state._convertList = result.convertList;
        state.currentIdx = state.customers.length > 0 ? 0 : -1;
        state.filteredIdx = state.customers.map((_, i) => i);
        state.fileName = file.name;
        state.dirty = false;
        saveToLocal();
        renderAll();
        toast(`已加载 ${state.customers.length} 条客户数据`, "success");
      } catch (err) {
        console.error(err);
        toast("加载失败: " + err.message, "error");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function parseConfigSheet(arr) {
    if (!arr || arr.length < 2) return null;
    const header = arr[0];
    const findCol = (name) => header.indexOf(name);
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const colRating = findCol("Rating_cfg");
    const colOffset = findCol("offset_value");
    const colCat = findCol("Category_cfg");
    const colRegion = findCol("Region_cfg");
    const colFrom = findCol("From_cfg");
    const colType = findCol("Contact_Type_cfg");
    const colStatus = findCol("Contact_Status_cfg");

    cfg.ratingList = [];
    cfg.ratingOffset = {};
    for (let i = 1; i < arr.length; i++) {
      const r = arr[i];
      if (colRating >= 0 && r[colRating]) {
        const name = String(r[colRating]).trim();
        if (name) {
          cfg.ratingList.push(name);
          const off = colOffset >= 0 ? r[colOffset] : 30;
          cfg.ratingOffset[name] = (off !== "" && off != null) ? Number(off) : 30;
        }
      }
    }
    const pickCol = (idx) => {
      const list = [];
      if (idx < 0) return list;
      for (let i = 1; i < arr.length; i++) {
        const v = arr[i][idx];
        if (v != null && String(v).trim()) list.push(String(v).trim());
      }
      return list;
    };
    cfg.categoryList = pickCol(colCat);
    cfg.regionList = pickCol(colRegion);
    cfg.fromList = pickCol(colFrom);
    cfg.contactTypeList = pickCol(colType);
    cfg.contactStatusList = pickCol(colStatus);
    return cfg;
  }

  function exportExcel() {
    if (state.customers.length === 0) {
      toast("没有数据可导出", "error");
      return;
    }
    const wb = XLSX.utils.book_new();

    // Sheet1 — main customer data
    const exportRows = state.customers.map((c, i) => {
      const row = {};
      for (const col of CUSTOMER_COLUMNS) {
        if (col === "Index") row[col] = i + 1;
        else row[col] = c[col];
      }
      return row;
    });
    const ws1 = XLSX.utils.json_to_sheet(exportRows, { header: CUSTOMER_COLUMNS });
    XLSX.utils.book_append_sheet(wb, ws1, "Sheet1");

    // config sheet
    const cfgMax = Math.max(
      state.config.ratingList.length,
      state.config.categoryList.length,
      state.config.regionList.length,
      state.config.fromList.length,
      state.config.contactTypeList.length,
      state.config.contactStatusList.length
    );
    const cfgRows = [];
    for (let i = 0; i < cfgMax; i++) {
      cfgRows.push({
        Row_number: i + 1,
        Rating_cfg: state.config.ratingList[i] || "",
        offset_value: state.config.ratingOffset[state.config.ratingList[i]] || "",
        Category_cfg: state.config.categoryList[i] || "",
        Region_cfg: state.config.regionList[i] || "",
        From_cfg: state.config.fromList[i] || "",
        Contact_Type_cfg: state.config.contactTypeList[i] || "",
        Contact_Status_cfg: state.config.contactStatusList[i] || "",
        Customer_Basic_column: CUSTOMER_COLUMNS[i] || "",
        Contact_Basic_column: CONTACT_COLUMNS[i] || "",
      });
    }
    const wsCfg = XLSX.utils.json_to_sheet(cfgRows);
    XLSX.utils.book_append_sheet(wb, wsCfg, "config");

    // NewList (empty template with header)
    const wsNew = XLSX.utils.json_to_sheet([], { header: CUSTOMER_COLUMNS });
    XLSX.utils.book_append_sheet(wb, wsNew, "NewList");

    // ConvertList (empty template)
    const convHeaders = [...CONTACT_COLUMNS, ...CUSTOMER_COLUMNS.filter(c => c !== "Contacts")];
    const wsConv = XLSX.utils.json_to_sheet([], { header: convHeaders });
    XLSX.utils.book_append_sheet(wb, wsConv, "ConvertList");

    const ts = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `客户总表_${ts}.xlsx`);
    toast("Excel 已导出", "success");
  }

  /* ============================================================
     LOCALSTORAGE PERSISTENCE
     ============================================================ */
  function saveToLocal() {
    try {
      const slim = state.customers.map(c => {
        const out = {};
        for (const col of CUSTOMER_COLUMNS) out[col] = c[col];
        return out;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        customers: slim,
        fileName: state.fileName,
        savedAt: new Date().toISOString(),
      }));
    } catch (e) { console.warn("localStorage save failed", e); }
  }

  function loadFromLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      if (!obj.customers || obj.customers.length === 0) return false;
      state.customers = obj.customers.map((r, i) => normalizeCustomer(r, i));
      state.fileName = obj.fileName || "(本地存档)";
      state.currentIdx = 0;
      state.filteredIdx = state.customers.map((_, i) => i);
      $("lastSaved").textContent = "本地存档 · " + (obj.savedAt ? new Date(obj.savedAt).toLocaleString() : "");
      return true;
    } catch (e) { return false; }
  }

  /* ============================================================
     SEARCH / FILTER
     ============================================================ */
  function applyFilter() {
    const q = $("searchInput").value.trim().toLowerCase();
    const cat = $("filterCategory").value;
    const rating = $("filterRating").value;
    const followup = $("filterFollowup").checked;
    const today = todayStr();

    state.filteredIdx = [];
    for (let i = 0; i < state.customers.length; i++) {
      const c = state.customers[i];
      // text search across multiple fields
      if (q) {
        const haystack = [c.ID, c.Company, c.Website, c.Region, c.Category, c.From, c.Log,
          ...c._contacts.map(ct => ct.Contact + " " + ct.Name)].join(" ").toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      if (cat && cat !== "全部" && c.Category !== cat) continue;
      if (rating && rating !== "全部" && c.Rating !== rating) continue;
      if (followup) {
        const nd = parseDate(c.Next);
        if (!nd || nd > new Date(today)) continue;
      }
      state.filteredIdx.push(i);
    }
    state.filterPage = 0;
    if (state.filteredIdx.length > 0) {
      state.currentIdx = state.filteredIdx[0];
    } else {
      state.currentIdx = -1;
    }
    renderList();
    renderDetail();
    updateStats();
  }

  /* ============================================================
     RENDER: STATS
     ============================================================ */
  function updateStats() {
    $("statTotal").textContent = state.customers.length;
    const today = todayStr();
    const followupCount = state.customers.filter(c => {
      const nd = parseDate(c.Next);
      return nd && nd <= new Date(today);
    }).length;
    $("statFollowup").textContent = followupCount;

    // rating breakdown
    const counts = {};
    for (const c of state.customers) {
      const r = c.Rating || "未分类";
      counts[r] = (counts[r] || 0) + 1;
    }
    const html = Object.entries(counts).map(([r, n]) =>
      `<span class="rb-item"><span>${escapeHtml(r)}</span><b>${n}</b></span>`
    ).join("");
    $("ratingBreakdown").innerHTML = html;
  }

  /* ============================================================
     RENDER: CUSTOMER LIST
     ============================================================ */
  function renderList() {
    const body = $("listBody");
    if (state.filteredIdx.length === 0) {
      body.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <p>没有匹配的客户</p>
        <span>尝试调整搜索条件</span></div>`;
      $("pageInfo").textContent = "0 / 0";
      return;
    }
    const today = todayStr();
    const html = state.filteredIdx.map((idx, i) => {
      const c = state.customers[idx];
      const nd = parseDate(c.Next);
      const isOverdue = nd && nd <= new Date(today);
      const active = idx === state.currentIdx ? "active" : "";
      const fu = isOverdue ? "followup" : "";
      const company = c.Company || "(未填公司)";
      const region = c.Region || "";
      const rating = c.Rating || "";
      return `<div class="customer-card ${active} ${fu}" data-idx="${idx}" data-page="${i}">
        <div class="cc-row1">
          <span class="cc-rating" data-r="${escapeHtml(rating)}">${escapeHtml(rating)}</span>
          <span class="cc-company">${escapeHtml(company)}</span>
          <span class="cc-region">${escapeHtml(region)}</span>
        </div>
        <div class="cc-row2">
          <span>${escapeHtml(c.Category || "")} · ${escapeHtml(c.From || "")}</span>
          <span class="cc-next ${isOverdue ? "overdue" : ""}">下次: ${escapeHtml(c.Next || "—")}</span>
        </div>
      </div>`;
    }).join("");
    body.innerHTML = html;
    // bind click
    body.querySelectorAll(".customer-card").forEach(el => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx);
        state.currentIdx = idx;
        state.filterPage = parseInt(el.dataset.page);
        renderList();
        renderDetail();
      });
    });
    const pagePos = state.filterPage + 1;
    $("pageInfo").textContent = `${pagePos} / ${state.filteredIdx.length}`;
  }

  /* ============================================================
     RENDER: DETAIL PANEL
     ============================================================ */
  function renderDetail() {
    const pane = $("detailPane");
    if (state.currentIdx < 0 || !state.customers[state.currentIdx]) {
      pane.innerHTML = `<div class="detail-empty">
        <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6M19 8v6"/></svg>
        <p>选择左侧客户或新建客户开始编辑</p></div>`;
      return;
    }
    const c = state.customers[state.currentIdx];

    const ratingChips = state.config.ratingList
      .filter(r => r !== "全部")
      .map(r => `<span class="rating-chip ${c.Rating === r ? "active" : ""}" data-r="${escapeHtml(r)}">${escapeHtml(r)}</span>`).join("");

    const nextChips = [
      { label: "1周", days: 7 },
      { label: "半月", days: 15 },
      { label: "1月", days: 30 },
      { label: "3月", days: 90 },
      { label: "半年", days: 183 },
      { label: "1年", days: 365 },
    ];
    const nextChipsHtml = nextChips.map(n =>
      `<span class="nq-chip" data-days="${n.days}">${n.label}</span>`).join("");

    pane.innerHTML = `
      <div class="detail-content">
        <div class="detail-header">
          <div class="detail-id">
            <div class="id-label">客户 ID</div>
            <div class="id-value">${escapeHtml(c.ID)}</div>
          </div>
          <div class="detail-rating-selector">
            <span class="lbl">等级 (点击切换)</span>
            <div class="rating-chips">${ratingChips}</div>
          </div>
        </div>

        <div class="next-quick">
          <span class="nq-label">下次联系：</span>
          ${nextChipsHtml}
          <span class="nq-date" id="nextDateDisplay">${escapeHtml(c.Next || "—")}</span>
        </div>

        <div class="field-grid">
          <div class="field">
            <span class="field-label">公司</span>
            <input class="field-input" data-col="Company" value="${escapeHtml(c.Company)}" />
          </div>
          <div class="field">
            <span class="field-label">网址</span>
            <input class="field-input" data-col="Website" value="${escapeHtml(c.Website)}" />
          </div>
          <div class="field">
            <span class="field-label">分类</span>
            <select class="field-input" data-col="Category">
              ${state.config.categoryList.filter(x=>x!=="全部").map(o => `<option ${c.Category===o?"selected":""}>${escapeHtml(o)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <span class="field-label">地区</span>
            <select class="field-input" data-col="Region">
              ${state.config.regionList.filter(x=>x!=="全部").map(o => `<option ${c.Region===o?"selected":""}>${escapeHtml(o)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <span class="field-label">来源</span>
            <input class="field-input" data-col="From" value="${escapeHtml(c.From)}" list="fromList" />
            <datalist id="fromList">${state.config.fromList.map(o=>`<option value="${escapeHtml(o)}">`).join("")}</datalist>
          </div>
          <div class="field">
            <span class="field-label">建档日期</span>
            <input class="field-input" data-col="Set" type="date" value="${escapeHtml(fmtDate(c.Set))}" />
          </div>
          <div class="field full">
            <span class="field-label">地址</span>
            <input class="field-input" data-col="Address" value="${escapeHtml(c.Address)}" />
          </div>
        </div>

        <div class="sub-section">
          <div class="sub-header">
            <span class="sub-title">联系方式 (双击单元格编辑/操作)</span>
            <div class="sub-actions">
              <button class="sbtn small" id="addContact">+ 添加</button>
            </div>
          </div>
          <div class="contacts-table" id="contactsTable">
            <div class="contacts-row header">
              <div>Type</div><div>Contact</div><div>Name</div><div>Status</div>
              <div>Com_Last</div><div>Records</div><div></div>
            </div>
            ${renderContactsRows(c)}
          </div>
          <div style="font-size:11px;color:var(--ink-faint);margin-top:4px;">
            提示：双击 Type/Status 切换值 · 双击 Com_Last 标记今日联系 · 双击 Com_Records 标记获得回复 · 双击 Contact 复制到剪贴板
          </div>
        </div>

        <div class="sub-section">
          <div class="sub-header">
            <span class="sub-title">跟进日志</span>
          </div>
          <textarea class="log-area" id="logArea" placeholder="记录沟通内容、客户需求、下一步计划…">${escapeHtml(c.Log)}</textarea>
        </div>

        <div class="action-bar">
          <button class="sbtn danger" id="btnDelete">删除客户</button>
          <button class="sbtn ghost" id="btnDuplicate">复制为新客户</button>
          <button class="sbtn success" id="btnSaveCustomer">保存</button>
        </div>
      </div>
    `;

    bindDetailEvents(c);
  }

  function renderContactsRows(c) {
    if (!c._contacts || c._contacts.length === 0) {
      return `<div class="contacts-row"><div style="grid-column:1/-1;color:var(--ink-faint);justify-content:center;">暂无联系方式，点击「+ 添加」</div></div>`;
    }
    const today = todayStr();
    return c._contacts.map((ct, i) => {
      const cl = fmtDate(ct.Com_Last);
      const isToday = cl === today;
      return `<div class="contacts-row" data-i="${i}">
        <div class="c-type" data-i="${i}">${escapeHtml(ct.Type)}</div>
        <div class="c-contact" data-i="${i}" title="点击复制">${escapeHtml(ct.Contact)}</div>
        <div class="c-name" data-i="${i}">${escapeHtml(ct.Name)}</div>
        <div class="c-status" data-i="${i}">${escapeHtml(ct.Status)}</div>
        <div class="c-comlast ${isToday ? "contact-today" : ""}" data-i="${i}">${escapeHtml(cl)}</div>
        <div class="c-comrecords" data-i="${i}">${escapeHtml(ct.Com_Records)}</div>
        <div class="c-del" data-i="${i}" title="删除">×</div>
      </div>`;
    }).join("");
  }

  /* ============================================================
     DETAIL EVENT BINDING
     ============================================================ */
  function bindDetailEvents(c) {
    // Field inputs — live update on change
    document.querySelectorAll(".field-input[data-col]").forEach(el => {
      el.addEventListener("change", () => {
        const col = el.dataset.col;
        c[col] = el.value;
        if (col === "Rating") { /* handled by chips */ }
        if (col === "Region" || col === "Category") {
          // rebuild ID suffix? keep as-is
        }
        autoSetDates(c);
        state.dirty = true;
        renderList();
      });
    });

    // Rating chips
    document.querySelectorAll(".rating-chip").forEach(el => {
      el.addEventListener("click", () => {
        const r = el.dataset.r;
        c.Rating = r;
        autoSetDates(c);
        state.dirty = true;
        renderDetail();
        renderList();
        updateStats();
      });
    });

    // Next date quick chips
    document.querySelectorAll(".nq-chip").forEach(el => {
      el.addEventListener("click", () => {
        const days = parseInt(el.dataset.days);
        c.Next = addDays(todayStr(), days);
        state.dirty = true;
        $("nextDateDisplay").textContent = c.Next;
        document.querySelectorAll(".nq-chip").forEach(x => x.classList.remove("active"));
        el.classList.add("active");
        renderList();
      });
    });

    // Add contact
    $("addContact").addEventListener("click", () => {
      c._contacts.push({
        Type: "Email", Contact: "new_contact", Name: "new_name",
        Status: "Active", Com_Last: "2000-01-01", Com_Records: "0r0"
      });
      syncContactsToCustomer(c);
      state.dirty = true;
      renderDetail();
    });

    // Contacts table interactions
    const table = $("contactsTable");
    table.addEventListener("dblclick", (e) => {
      const target = e.target.closest("[data-i]");
      if (!target) return;
      const i = parseInt(target.dataset.i);
      const ct = c._contacts[i];
      if (!ct) return;
      const cls = target.className;

      if (cls.includes("c-type")) {
        const list = state.config.contactTypeList;
        const idx = list.indexOf(ct.Type);
        ct.Type = list[(idx + 1) % list.length];
      } else if (cls.includes("c-status")) {
        const list = state.config.contactStatusList;
        const idx = list.indexOf(ct.Status);
        ct.Status = list[(idx + 1) % list.length];
      } else if (cls.includes("c-comlast")) {
        // mark contacted today
        const today = todayStr();
        const cur = fmtDate(ct.Com_Last);
        if (cur !== today) {
          ct.Com_Last = today;
          ct.Com_Records = bumpPair(ct.Com_Records, true);
          c.Log = (c.Log || "") + `\n ${today}: 联系了 ${ct.Contact}`;
          $("logArea").value = c.Log;
          toast(`已记录今日联系: ${ct.Contact}`, "success");
        } else {
          toast("今日已联系过", "error");
        }
      } else if (cls.includes("c-comrecords")) {
        // mark got reply
        ct.Com_Last = todayStr();
        ct.Com_Records = bumpPair(ct.Com_Records, false);
        c.Log = (c.Log || "") + `\n ${todayStr()}: 获得 ${ct.Contact} 的回复`;
        $("logArea").value = c.Log;
        toast(`已记录回复: ${ct.Contact}`, "success");
      } else if (cls.includes("c-contact") || cls.includes("c-name")) {
        // inline edit
        inlineEdit(target, ct, cls.includes("c-contact") ? "Contact" : "Name", () => {
          syncContactsToCustomer(c);
          state.dirty = true;
          renderDetail();
        });
        return;
      }
      syncContactsToCustomer(c);
      state.dirty = true;
      renderDetail();
      renderList();
    });

    // single click on contact = copy
    table.addEventListener("click", (e) => {
      if (e.target.classList.contains("c-contact") && !e.detail || e.detail === 1) {
        // use a small delay to distinguish from dblclick
        const val = e.target.textContent;
        setTimeout(() => {
          if (e.detail === 1) {
            navigator.clipboard.writeText(val).then(() => toast(`已复制: ${val}`)).catch(() => {});
          }
        }, 200);
      }
    });

    // Delete contact
    table.addEventListener("click", (e) => {
      if (e.target.classList.contains("c-del")) {
        const i = parseInt(e.target.dataset.i);
        c._contacts.splice(i, 1);
        syncContactsToCustomer(c);
        state.dirty = true;
        renderDetail();
      }
    });

    // Log live update
    $("logArea").addEventListener("input", () => {
      c.Log = $("logArea").value;
      state.dirty = true;
    });

    // Save
    $("btnSaveCustomer").addEventListener("click", saveCurrentCustomer);
    // Delete
    $("btnDelete").addEventListener("click", () => {
      showConfirm("删除客户", `确定删除客户「${c.Company || c.ID}」吗？此操作不可撤销。`, () => {
        state.customers.splice(state.currentIdx, 1);
        state.filteredIdx = state.filteredIdx.filter(i => i !== state.currentIdx)
          .map(i => i > state.currentIdx ? i - 1 : i);
        state.currentIdx = state.filteredIdx.length > 0 ? state.filteredIdx[0] : -1;
        state.dirty = true;
        saveToLocal();
        renderAll();
        toast("客户已删除", "success");
      });
    });
    // Duplicate as new
    $("btnDuplicate").addEventListener("click", () => {
      const dup = JSON.parse(JSON.stringify(c));
      dup._contacts = c._contacts.map(ct => ({ ...ct }));
      dup.ID = "";
      dup.Company = (c.Company || "") + " (副本)";
      normalizeCustomer(dup, state.customers.length);
      state.customers.push(dup);
      state.currentIdx = state.customers.length - 1;
      state.filteredIdx.push(state.currentIdx);
      state.dirty = true;
      saveToLocal();
      renderAll();
      toast("已复制为新客户，请修改 ID/公司后保存", "success");
    });
  }

  function inlineEdit(el, obj, field, onDone) {
    const oldVal = obj[field];
    const input = document.createElement("input");
    input.type = "text";
    input.value = oldVal;
    input.className = "field-input";
    input.style.cssText = "height:28px;font-size:12px;padding:2px 6px;";
    el.innerHTML = "";
    el.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      obj[field] = input.value;
      onDone();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = oldVal; input.blur(); }
    });
  }

  function bumpPair(pair, left) {
    try {
      const [l, r] = String(pair).split("r");
      const ln = parseInt(l) || 0;
      const rn = parseInt(r) || 0;
      return left ? `${ln + 1}r${rn}` : `${ln}r${rn + 1}`;
    } catch (e) { return "1r0"; }
  }

  /* ============================================================
     SAVE CURRENT CUSTOMER (with duplicate check on new)
     ============================================================ */
  function saveCurrentCustomer() {
    if (state.currentIdx < 0) {
      toast("没有选中客户", "error");
      return;
    }
    const c = state.customers[state.currentIdx];
    // ensure ID
    if (!c.ID || String(c.ID).trim() === "") {
      c.ID = genId() + " " + (c.Region || "未知地区") + " " + (c.Category || "未知品类") + " " + (c.Company || "未知公司");
    }
    syncContactsToCustomer(c);

    // Check duplicates for Company / Website / contacts if this is a "new" customer (was added via New)
    if (c._isNew) {
      const checks = ["Company", "Website"];
      for (const col of checks) {
        const val = c[col];
        if (val && String(val).trim() && String(val).toLowerCase() !== "none") {
          const dup = state.customers.findIndex((other, i) => i !== state.currentIdx && other[col] && String(other[col]).toLowerCase() === String(val).toLowerCase());
          if (dup >= 0) {
            toast(`保存失败：${col}「${val}」与第 ${dup + 1} 条重复`, "error");
            return;
          }
        }
      }
      // contacts duplicate
      for (const ct of c._contacts) {
        const dup = state.customers.findIndex((other, i) => i !== state.currentIdx && other._contacts.some(oct => oct.Contact === ct.Contact));
        if (dup >= 0) {
          toast(`保存失败：联系方式「${ct.Contact}」与第 ${dup + 1} 条重复`, "error");
          return;
        }
      }
      c._isNew = false;
    }

    state.dirty = true;
    saveToLocal();
    renderList();
    updateStats();
    toast("客户信息已保存", "success");
  }

  /* ============================================================
     NEW CUSTOMER
     ============================================================ */
  function newCustomer() {
    const template = state.currentIdx >= 0 ? state.customers[state.currentIdx] : null;
    const c = {
      Index: state.customers.length + 1,
      ID: "",
      Contacts: "",
      Rating: template ? template.Rating : "普通",
      Set: todayStr(),
      Last: todayStr(),
      Next: todayStr(),
      Address: "",
      Company: "",
      Website: "",
      Category: template ? template.Category : "",
      Region: template ? template.Region : "",
      From: template ? template.From : "",
      Log: "",
      _contacts: [{
        Type: "Email", Contact: "new_contact", Name: "new_name",
        Status: "Active", Com_Last: "2000-01-01", Com_Records: "0r0"
      }],
      _isNew: true,
    };
    state.customers.push(c);
    state.currentIdx = state.customers.length - 1;
    state.filteredIdx = state.customers.map((_, i) => i);
    state.filterPage = state.filteredIdx.length - 1;
    saveToLocal();
    renderAll();
    toast("已创建新客户，请填写信息后保存", "success");
  }

  /* ============================================================
     BATCH IMPORT (from NewList)
     ============================================================ */
  function batchImport() {
    if (!state._newList || state._newList.length === 0) {
      // allow user to import a separate file
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".xlsx,.xls";
      input.onchange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array", cellDates: true });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
          doBatchImport(rows);
        };
        reader.readAsArrayBuffer(f);
      };
      input.click();
      return;
    }
    doBatchImport(state._newList);
  }

  function doBatchImport(rows) {
    let added = 0, failed = 0;
    const failures = [];
    for (const row of rows) {
      const c = normalizeCustomer(row, state.customers.length);
      c._isNew = true;
      // duplicate check
      let isDup = false;
      for (const col of ["Company", "Website"]) {
        const val = c[col];
        if (val && String(val).trim() && String(val).toLowerCase() !== "none") {
          if (state.customers.some(o => o[col] && String(o[col]).toLowerCase() === String(val).toLowerCase())) {
            failures.push(`${c.Company || c.ID}: ${col}重复`);
            isDup = true; break;
          }
        }
      }
      if (!isDup) {
        for (const ct of c._contacts) {
          if (state.customers.some(o => o._contacts.some(oct => oct.Contact === ct.Contact))) {
            failures.push(`${c.Company || c.ID}: 联系方式${ct.Contact}重复`);
            isDup = true; break;
          }
        }
      }
      if (isDup) { failed++; continue; }
      c._isNew = false;
      state.customers.push(c);
      added++;
    }
    state.filteredIdx = state.customers.map((_, i) => i);
    saveToLocal();
    renderAll();
    toast(`批量导入完成：新增 ${added} 条，跳过 ${failed} 条重复`, added > 0 ? "success" : "error");
    if (failures.length > 0) console.log("导入失败明细:", failures);
  }

  /* ============================================================
     BATCH UPDATE (placeholder — operates on ConvertList data)
     ============================================================ */
  function batchUpdate() {
    // For the web version, batch update = re-apply auto dates to all customers
    // (since ConvertList workflow was Excel-specific). Provide a useful alternative:
    let updated = 0;
    for (const c of state.customers) {
      const before = c.Next;
      autoSetDates(c);
      if (c.Next !== before) updated++;
    }
    saveToLocal();
    renderAll();
    toast(`批量更新完成：${updated} 条客户的跟进日期已刷新`, "success");
  }

  /* ============================================================
     NAVIGATION
     ============================================================ */
  function gotoNext() {
    if (state.filteredIdx.length === 0) return;
    state.filterPage = (state.filterPage + 1) % state.filteredIdx.length;
    state.currentIdx = state.filteredIdx[state.filterPage];
    renderList();
    renderDetail();
  }
  function gotoPrev() {
    if (state.filteredIdx.length === 0) return;
    state.filterPage = (state.filterPage - 1 + state.filteredIdx.length) % state.filteredIdx.length;
    state.currentIdx = state.filteredIdx[state.filterPage];
    renderList();
    renderDetail();
  }
  function gotoRow(n) {
    if (n < 1 || n > state.customers.length) {
      toast("行号超出范围", "error"); return;
    }
    state.currentIdx = n - 1;
    state.filterPage = state.filteredIdx.indexOf(state.currentIdx);
    if (state.filterPage < 0) {
      // not in filtered set — reset filter
      state.filteredIdx = state.customers.map((_, i) => i);
      state.filterPage = state.currentIdx;
    }
    renderList();
    renderDetail();
  }

  /* ============================================================
     CONFIG MODAL
     ============================================================ */
  function openConfig() {
    const body = $("configBody");
    const cfg = state.config;
    body.innerHTML = `
      <div class="cfg-section">
        <h4>等级与跟进周期（天）</h4>
        <div id="cfgRating"></div>
        <div class="cfg-add">
          <input type="text" id="newRatingName" placeholder="新等级名称" />
          <input type="number" id="newRatingOffset" placeholder="天数" style="width:80px" />
          <button class="sbtn small" id="addRating">添加</button>
        </div>
      </div>
      <div class="cfg-section">
        <h4>分类</h4>
        <div class="cfg-list" id="cfgCategory"></div>
        <div class="cfg-add"><input type="text" id="newCat" placeholder="新分类" /><button class="sbtn small" id="addCat">添加</button></div>
      </div>
      <div class="cfg-section">
        <h4>地区</h4>
        <div class="cfg-list" id="cfgRegion"></div>
        <div class="cfg-add"><input type="text" id="newRegion" placeholder="新地区" /><button class="sbtn small" id="addRegion">添加</button></div>
      </div>
      <div class="cfg-section">
        <h4>来源</h4>
        <div class="cfg-list" id="cfgFrom"></div>
        <div class="cfg-add"><input type="text" id="newFrom" placeholder="新来源" /><button class="sbtn small" id="addFrom">添加</button></div>
      </div>
      <div class="cfg-section">
        <h4>联系方式类型</h4>
        <div class="cfg-list" id="cfgType"></div>
        <div class="cfg-add"><input type="text" id="newType" placeholder="新类型" /><button class="sbtn small" id="addType">添加</button></div>
      </div>
      <div class="cfg-section">
        <h4>联系状态</h4>
        <div class="cfg-list" id="cfgStatus"></div>
        <div class="cfg-add"><input type="text" id="newStatus" placeholder="新状态" /><button class="sbtn small" id="addStatus">添加</button></div>
      </div>
    `;
    renderCfgList("cfgRating", cfg.ratingList.filter(r => r !== "全部"), (name) => {
      const off = cfg.ratingOffset[name] || 30;
      return `<div class="cfg-rating-row">
        <input type="text" value="${escapeHtml(name)}" data-old="${escapeHtml(name)}" class="cfg-rating-name" />
        <input type="number" value="${off}" data-name="${escapeHtml(name)}" class="cfg-rating-offset" />
        <span class="cfg-item-rm" data-name="${escapeHtml(name)}" style="cursor:pointer;color:var(--danger);">×</span>
      </div>`;
    });
    renderCfgList("cfgCategory", cfg.categoryList.filter(x => x !== "全部"));
    renderCfgList("cfgRegion", cfg.regionList.filter(x => x !== "全部"));
    renderCfgList("cfgFrom", cfg.fromList);
    renderCfgList("cfgType", cfg.contactTypeList);
    renderCfgList("cfgStatus", cfg.contactStatusList);

    // bind adds
    $("addRating").onclick = () => {
      const n = $("newRatingName").value.trim();
      const o = parseInt($("newRatingOffset").value) || 30;
      if (n && !cfg.ratingList.includes(n)) { cfg.ratingList.push(n); cfg.ratingOffset[n] = o; openConfig(); }
    };
    const bindAdd = (id, inputId, listKey) => {
      $(id).onclick = () => {
        const v = $(inputId).value.trim();
        if (v && !cfg[listKey].includes(v)) { cfg[listKey].push(v); openConfig(); }
      };
    };
    bindAdd("addCat", "newCat", "categoryList");
    bindAdd("addRegion", "newRegion", "regionList");
    bindAdd("addFrom", "newFrom", "fromList");
    bindAdd("addType", "newType", "contactTypeList");
    bindAdd("addStatus", "newStatus", "contactStatusList");

    // bind rating edit/remove
    body.querySelectorAll(".cfg-rating-row").forEach(row => {
      const nameInput = row.querySelector(".cfg-rating-name");
      const offInput = row.querySelector(".cfg-rating-offset");
      const rm = row.querySelector(".cfg-item-rm");
      nameInput.onchange = () => {
        const old = nameInput.dataset.old;
        const nw = nameInput.value.trim();
        if (nw && nw !== old) {
          const idx = cfg.ratingList.indexOf(old);
          cfg.ratingList[idx] = nw;
          cfg.ratingOffset[nw] = cfg.ratingOffset[old];
          delete cfg.ratingOffset[old];
          openConfig();
        }
      };
      offInput.onchange = () => {
        cfg.ratingOffset[offInput.dataset.name] = parseInt(offInput.value) || 30;
      };
      rm.onclick = () => {
        const name = rm.dataset.name;
        const idx = cfg.ratingList.indexOf(name);
        if (idx >= 0) { cfg.ratingList.splice(idx, 1); delete cfg.ratingOffset[name]; openConfig(); }
      };
    });

    // bind list removes (for category/region/from/type/status)
    const bindListRm = (containerId, listKey) => {
      $(containerId).querySelectorAll(".cfg-item .rm").forEach(rm => {
        rm.onclick = () => {
          const v = rm.dataset.val;
          const idx = cfg[listKey].indexOf(v);
          if (idx >= 0) { cfg[listKey].splice(idx, 1); openConfig(); }
        };
      });
    };
    bindListRm("cfgCategory", "categoryList");
    bindListRm("cfgRegion", "regionList");
    bindListRm("cfgFrom", "fromList");
    bindListRm("cfgType", "contactTypeList");
    bindListRm("cfgStatus", "contactStatusList");

    $("configModal").hidden = false;
  }

  function renderCfgList(containerId, items, customRenderer) {
    const c = $(containerId);
    if (customRenderer) {
      c.innerHTML = items.map(customRenderer).join("");
    } else {
      c.innerHTML = items.map(v => `<span class="cfg-item">${escapeHtml(v)} <span class="rm" data-val="${escapeHtml(v)}">×</span></span>`).join("");
    }
  }

  /* ============================================================
     CONFIRM MODAL
     ============================================================ */
  let confirmCallback = null;
  function showConfirm(title, msg, onYes) {
    $("confirmTitle").textContent = title;
    $("confirmMsg").textContent = msg;
    confirmCallback = onYes;
    $("confirmModal").hidden = false;
  }

  /* ============================================================
     RENDER ALL
     ============================================================ */
  function renderAll() {
    populateFilterDropdowns();
    renderList();
    renderDetail();
    updateStats();
    $("lastSaved").textContent = state.fileName ? `当前文件: ${state.fileName}` : "未加载数据";
  }

  function populateFilterDropdowns() {
    const catSel = $("filterCategory");
    const ratSel = $("filterRating");
    catSel.innerHTML = `<option value="">全部</option>` + state.config.categoryList.filter(x=>x!=="全部").map(o => `<option>${escapeHtml(o)}</option>`).join("");
    ratSel.innerHTML = `<option value="">全部</option>` + state.config.ratingList.filter(x=>x!=="全部").map(o => `<option>${escapeHtml(o)}</option>`).join("");
  }

  /* ============================================================
     INIT & EVENT WIRING
     ============================================================ */
  function init() {
    // Buttons
    $("btnOpen").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", (e) => {
      if (e.target.files[0]) importExcel(e.target.files[0]);
      e.target.value = "";
    });
    $("btnSave").addEventListener("click", exportExcel);
    $("btnImport").addEventListener("click", batchImport);
    $("btnNew").addEventListener("click", newCustomer);
    $("btnBatchUpdate").addEventListener("click", batchUpdate);
    $("btnConfig").addEventListener("click", openConfig);

    $("btnSearch").addEventListener("click", applyFilter);
    $("btnClearSearch").addEventListener("click", () => {
      $("searchInput").value = "";
      $("filterCategory").value = "";
      $("filterRating").value = "";
      $("filterFollowup").checked = true;
      applyFilter();
    });
    $("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") applyFilter(); });

    $("btnPrev").addEventListener("click", gotoPrev);
    $("btnNext").addEventListener("click", gotoNext);
    $("gotoRow").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const v = parseInt($("gotoRow").value); if (v) gotoRow(v); $("gotoRow").value = ""; }
    });

    // Config modal
    $("configClose").addEventListener("click", () => { $("configModal").hidden = true; });
    $("configCancel").addEventListener("click", () => { $("configModal").hidden = true; });
    $("configSave").addEventListener("click", () => {
      saveConfig();
      $("configModal").hidden = true;
      populateFilterDropdowns();
      toast("配置已保存", "success");
    });

    // Confirm modal
    $("confirmYes").addEventListener("click", () => {
      $("confirmModal").hidden = true;
      if (confirmCallback) confirmCallback();
      confirmCallback = null;
    });
    $("confirmNo").addEventListener("click", () => { $("confirmModal").hidden = true; confirmCallback = null; });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (e.key === "ArrowLeft") gotoPrev();
      if (e.key === "ArrowRight") gotoNext();
      if (e.key === "n" && e.ctrlKey) { e.preventDefault(); newCustomer(); }
      if (e.key === "s" && e.ctrlKey) { e.preventDefault(); saveCurrentCustomer(); }
    });

    // Try load from localStorage
    if (loadFromLocal()) {
      renderAll();
      toast(`已从本地恢复 ${state.customers.length} 条客户数据`, "success");
    } else {
      populateFilterDropdowns();
      updateStats();
    }

    // Auto-save on unload
    window.addEventListener("beforeunload", () => {
      if (state.dirty) saveToLocal();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
