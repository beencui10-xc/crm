/* ============================================================
   Mobile UI Layer (V5.1) — WeChat-style multi-page experience
   - Activates only when viewport <= 820px (phones / PWA standalone)
   - Desktop layout is completely untouched
   - Reads/writes the same state via window.CFMS bridge (app.js)
   Pages: 客户列表 → 客户详情 → 联系方式
   ============================================================ */
(function () {
  "use strict";

  const mq = window.matchMedia("(max-width: 820px)");
  let api = null;          // window.CFMS bridge
  let booted = false;
  let view = "list";       // list | detail | contacts
  let curIdx = -1;
  let mSearch = "";
  let mRating = "";
  let mFollowupOnly = false;

  const RATING_COLORS = {
    "重要": "#e05252", "关注": "#e08a3c", "普通": "#4f74e3",
    "待开发": "#8b6ce0", "忽略": "#9aa3b2", "无效": "#6b7280",
  };

  /* ---------------- root DOM ---------------- */
  const ROOT_HTML = `
  <div id="mApp" hidden>
    <!-- ============ PAGE 1: 客户列表 ============ -->
    <div class="m-page" id="mPageList">
      <header class="m-topbar">
        <div class="m-topbar-title">
          <span class="m-logo">👥</span>
          <div><b>客户跟进</b><small id="mSyncLine">☁️ 未连接</small></div>
        </div>
        <button class="m-icon-btn" id="mBtnSettings" title="配置">⚙️</button>
      </header>
      <div class="m-search-row">
        <input type="search" id="mSearch" placeholder="搜索 公司 / 联系人 / 网址…" />
      </div>
      <div class="m-chip-row" id="mChipRow"></div>
      <div class="m-list" id="mList"></div>
    </div>

    <!-- ============ PAGE 2: 客户详情 ============ -->
    <div class="m-page" id="mPageDetail" hidden>
      <header class="m-topbar">
        <button class="m-icon-btn" id="mBtnBackList">‹</button>
        <div class="m-topbar-center" id="mDetailTitle">客户详情</div>
        <span class="m-icon-btn-spacer"></span>
      </header>
      <div class="m-detail" id="mDetailBody"></div>
    </div>

    <!-- ============ PAGE 3: 联系方式 ============ -->
    <div class="m-page" id="mPageContacts" hidden>
      <header class="m-topbar">
        <button class="m-icon-btn" id="mBtnBackDetail">‹</button>
        <div class="m-topbar-center" id="mContactsTitle">联系方式</div>
        <button class="m-icon-btn" id="mBtnAddContact" title="添加联系方式">＋</button>
      </header>
      <div class="m-contacts" id="mContactsBody"></div>
    </div>

    <!-- ============ BOTTOM SHEET (forms) ============ -->
    <div class="m-sheet-backdrop" id="mSheetBackdrop" hidden>
      <div class="m-sheet" id="mSheet"></div>
    </div>
  </div>`;

  /* ---------------- utilities ---------------- */
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const $m = (id) => document.getElementById(id);

  function bumpPair(pair, left) {
    try {
      const [l, r] = String(pair).split("r");
      const ln = parseInt(l) || 0, rn = parseInt(r) || 0;
      return left ? `${ln + 1}r${rn}` : `${ln}r${rn + 1}`;
    } catch (e) { return "1r0"; }
  }

  function persist(c) {
    // c mutated → dates auto-set + contacts serialized + local save + cloud debounce
    api.syncContactsToCustomer(c);
    api.markDirty();
    api.saveToLocal();
    api.refreshUI();
    renderCurrent();
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(
        () => api.toast("已复制", "success"),
        () => api.toast("复制失败", "error"));
    } else {
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); api.toast("已复制", "success"); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  /* ---------------- bottom sheet ---------------- */
  function openSheet(html) {
    $m("mSheet").innerHTML = html;
    $m("mSheetBackdrop").hidden = false;
    requestAnimationFrame(() => $m("mSheetBackdrop").classList.add("show"));
  }
  function closeSheet() {
    const bd = $m("mSheetBackdrop");
    bd.classList.remove("show");
    setTimeout(() => { bd.hidden = true; $m("mSheet").innerHTML = ""; }, 200);
  }

  /* ---------------- navigation ---------------- */
  function showView(v) {
    view = v;
    $m("mPageList").hidden = v !== "list";
    $m("mPageDetail").hidden = v !== "detail";
    $m("mPageContacts").hidden = v !== "contacts";
    renderCurrent();
    window.scrollTo(0, 0);
  }
  function renderCurrent() {
    if (!api) return;
    if (view === "list") renderListPage();
    else if (view === "detail") renderDetailPage();
    else renderContactsPage();
  }

  /* ---------------- PAGE 1: list ---------------- */
  function filteredCustomers() {
    const today = api.todayStr();
    return api.state.customers
      .map((c, idx) => ({ c, idx }))
      .filter(({ c }) => {
        if (mRating && (c.Rating || "") !== mRating) return false;
        if (mFollowupOnly) {
          const nd = api.parseDate(c.Next);
          if (!nd || nd > new Date(today)) return false;
        }
        if (mSearch) {
          const hay = [c.ID, c.Company, c.Website, c.Region, c.Category, c.From, c.Log,
            ...(c._contacts || []).map(t => t.Contact + " " + t.Name)]
            .join(" ").toLowerCase();
          if (!hay.includes(mSearch)) return false;
        }
        return true;
      });
  }

  function renderChipRow() {
    const ratings = (api.state.config.ratingList || []).filter(r => r !== "全部");
    let html = `<button class="m-chip ${mRating === "" && !mFollowupOnly ? "active" : ""}" data-r="">全部</button>`;
    html += `<button class="m-chip warn ${mFollowupOnly ? "active" : ""}" id="mChipFollowup">⏰ 待跟进</button>`;
    for (const r of ratings) {
      const col = RATING_COLORS[r] || "#9aa3b2";
      html += `<button class="m-chip ${mRating === r ? "active" : ""}" data-r="${esc(r)}" style="${mRating === r ? `background:${col};border-color:${col}` : `color:${col}`}">${esc(r)}</button>`;
    }
    $m("mChipRow").innerHTML = html;
    $m("mChipRow").querySelectorAll(".m-chip").forEach(el => {
      el.addEventListener("click", () => {
        if (el.id === "mChipFollowup") { mFollowupOnly = !mFollowupOnly; }
        else { mRating = el.dataset.r || ""; }
        renderChipRow(); renderListPage();
      });
    });
  }

  function renderListPage() {
    // sync status line mirrors desktop pill
    const pill = document.getElementById("cloudSyncStatus");
    if (pill) $m("mSyncLine").textContent = pill.textContent || "";

    renderChipRow();
    const rows = filteredCustomers();
    const total = api.state.customers.length;
    const today = api.todayStr();

    let html = "";
    if (rows.length === 0) {
      html = `<div class="m-empty">${total === 0
        ? "暂无客户数据<br><small>桌面端导入 Excel 或连接云库后，手机自动同步</small>"
        : "没有匹配的客户"}</div>`;
    }
    for (const { c, idx } of rows) {
      const nd = api.parseDate(c.Next);
      const overdue = nd && nd <= new Date(today);
      const rCol = RATING_COLORS[c.Rating] || "#9aa3b2";
      const nContacts = (c._contacts || []).length;
      html += `<div class="m-card m-cust" data-idx="${idx}">
        <div class="m-cust-top">
          <span class="m-rating-dot" style="background:${rCol}"></span>
          <span class="m-cust-name">${esc(c.Company || c.ID || "未命名客户")}</span>
          ${overdue ? '<span class="m-badge overdue">待跟进</span>' : ""}
        </div>
        <div class="m-cust-meta">${esc([c.Region, c.Category].filter(Boolean).join(" · ") || "—")}</div>
        <div class="m-cust-bottom">
          <span class="m-next ${overdue ? "overdue" : ""}">Next: ${esc(api.fmtDate(c.Next) || "—")}</span>
          <span class="m-ct-n">📞 ${nContacts}</span>
        </div>
      </div>`;
    }
    html += `<div class="m-list-count">共 ${rows.length} / ${total} 位客户</div>`;
    $m("mList").innerHTML = html;
    $m("mList").querySelectorAll(".m-cust").forEach(el => {
      el.addEventListener("click", () => {
        curIdx = parseInt(el.dataset.idx);
        api.state.currentIdx = curIdx;   // keep desktop detail in sync
        showView("detail");
      });
    });
  }

  /* ---------------- PAGE 2: detail ---------------- */
  function renderDetailPage() {
    const c = api.state.customers[curIdx];
    if (!c) { showView("list"); return; }
    $m("mDetailTitle").textContent = c.Company || c.ID || "客户详情";
    const today = api.todayStr();
    const rCol = RATING_COLORS[c.Rating] || "#9aa3b2";
    const nd = api.parseDate(c.Next);
    const overdue = nd && nd <= new Date(today);
    const ratings = (api.state.config.ratingList || []).filter(r => r !== "全部");

    const chips = ratings.map(r => {
      const col = RATING_COLORS[r] || "#9aa3b2";
      const on = c.Rating === r;
      return `<button class="m-chip ${on ? "active" : ""}" data-r="${esc(r)}" style="${on ? `background:${col};border-color:${col}` : `color:${col}`}">${esc(r)}</button>`;
    }).join("");

    const site = c.Website
      ? `<a class="m-info-link" data-site="${esc(c.Website)}">${esc(c.Website)}</a>` : "—";

    $m("mDetailBody").innerHTML = `
      <div class="m-card">
        <div class="m-sec-title">等级 <span class="m-rating-now" style="color:${rCol}">${esc(c.Rating || "未分类")}</span></div>
        <div class="m-chip-row wrap">${chips}</div>
        <div class="m-info-grid">
          <div class="m-info-item"><label>建立</label><b>${esc(api.fmtDate(c.Set) || "—")}</b></div>
          <div class="m-info-item"><label>最近联系</label><b>${esc(api.fmtDate(c.Last) || "—")}</b></div>
          <div class="m-info-item"><label>下次跟进</label><b class="${overdue ? "overdue" : ""}">${esc(api.fmtDate(c.Next) || "—")}</b></div>
          <div class="m-info-item"><label>地区</label><b>${esc(c.Region || "—")}</b></div>
          <div class="m-info-item"><label>品类</label><b>${esc(c.Category || "—")}</b></div>
          <div class="m-info-item"><label>来源</label><b>${esc(c.From || "—")}</b></div>
          <div class="m-info-item wide"><label>网址</label><b>${site}</b></div>
          <div class="m-info-item wide"><label>地址</label><b>${esc(c.Address || "—")}</b></div>
        </div>
        <div class="m-btn-row">
          <button class="m-btn primary" id="mBtnEditInfo">✏️ 编辑资料</button>
          <button class="m-btn" id="mBtnNextDate">📅 下次跟进</button>
        </div>
      </div>

      <div class="m-card tap-card" id="mGotoContacts">
        <span>📞 联系方式 <b>(${(c._contacts || []).length})</b></span>
        <span class="m-arrow">›</span>
      </div>

      <div class="m-card">
        <div class="m-sec-title">跟进记录
          <button class="m-mini-btn" id="mBtnAddLog">＋ 添加</button>
        </div>
        <div class="m-log">${c.Log ? esc(c.Log) : "暂无记录"}</div>
      </div>`;

    // rating chips
    $m("mDetailBody").querySelectorAll(".m-chip").forEach(el => {
      el.addEventListener("click", () => {
        c.Rating = el.dataset.r;
        persist(c);
        api.toast(`等级已设为「${c.Rating}」`, "success");
      });
    });
    // website
    const link = $m("mDetailBody").querySelector(".m-info-link");
    if (link) link.addEventListener("click", () => api.triggerContactAction(c.Website, "Website"));
    // goto contacts
    $m("mGotoContacts").addEventListener("click", () => showView("contacts"));
    // edit info sheet
    $m("mBtnEditInfo").addEventListener("click", () => openEditSheet(c));
    // next date sheet
    $m("mBtnNextDate").addEventListener("click", () => openNextDateSheet(c));
    // add log
    $m("mBtnAddLog").addEventListener("click", () => openLogSheet(c));
  }

  function openEditSheet(c) {
    const cfg = api.state.config;
    const opt = (list, sel) => `<option value="">—</option>` +
      (list || []).filter(x => x !== "全部").map(x =>
        `<option ${x === sel ? "selected" : ""}>${esc(x)}</option>`).join("");
    openSheet(`
      <div class="m-sheet-title">编辑客户资料</div>
      <label class="m-f-label">公司</label>
      <input class="m-f-input" id="mFCompany" value="${esc(c.Company)}" />
      <label class="m-f-label">网址</label>
      <input class="m-f-input" id="mFWebsite" value="${esc(c.Website)}" />
      <label class="m-f-label">地址</label>
      <input class="m-f-input" id="mFAddress" value="${esc(c.Address)}" />
      <div class="m-f-grid">
        <div><label class="m-f-label">地区</label><select class="m-f-input" id="mFRegion">${opt(cfg.regionList, c.Region)}</select></div>
        <div><label class="m-f-label">品类</label><select class="m-f-input" id="mFCategory">${opt(cfg.categoryList, c.Category)}</select></div>
        <div><label class="m-f-label">来源</label><select class="m-f-input" id="mFFrom">${opt(cfg.fromList, c.From)}</select></div>
        <div><label class="m-f-label">下次跟进</label><input class="m-f-input" type="date" id="mFNext" value="${esc(api.fmtDate(c.Next))}" /></div>
      </div>
      <div class="m-btn-row sheet">
        <button class="m-btn primary" id="mFSave">保存</button>
        <button class="m-btn" id="mFCancel">取消</button>
      </div>`);
    $m("mFSave").addEventListener("click", () => {
      c.Company = $m("mFCompany").value.trim();
      c.Website = $m("mFWebsite").value.trim();
      c.Address = $m("mFAddress").value.trim();
      c.Region = $m("mFRegion").value;
      c.Category = $m("mFCategory").value;
      c.From = $m("mFFrom").value;
      const nd = $m("mFNext").value;
      if (nd) c.Next = nd;
      persist(c);
      closeSheet();
      api.toast("客户资料已保存", "success");
    });
    $m("mFCancel").addEventListener("click", closeSheet);
  }

  function openNextDateSheet(c) {
    openSheet(`
      <div class="m-sheet-title">下次跟进日期</div>
      <input class="m-f-input" type="date" id="mNextPick" value="${esc(api.fmtDate(c.Next))}" />
      <div class="m-btn-row sheet">
        <button class="m-btn primary" id="mNextSave">保存</button>
        <button class="m-btn" id="mNextCancel">取消</button>
      </div>`);
    $m("mNextSave").addEventListener("click", () => {
      const v = $m("mNextPick").value;
      if (v) { c.Next = v; persist(c); api.toast("已更新下次跟进日期", "success"); }
      closeSheet();
    });
    $m("mNextCancel").addEventListener("click", closeSheet);
  }

  function openLogSheet(c) {
    openSheet(`
      <div class="m-sheet-title">添加跟进记录</div>
      <textarea class="m-f-input m-f-textarea" id="mLogText" rows="4"
        placeholder="记录本次沟通内容…（自动附带日期前缀）"></textarea>
      <div class="m-btn-row sheet">
        <button class="m-btn primary" id="mLogSave">保存</button>
        <button class="m-btn" id="mLogCancel">取消</button>
      </div>`);
    setTimeout(() => $m("mLogText").focus(), 150);
    $m("mLogSave").addEventListener("click", () => {
      const t = $m("mLogText").value.trim();
      if (!t) { api.toast("请输入内容", "error"); return; }
      c.Log = (c.Log ? c.Log + "\n" : "") + `${api.todayStr()}: ${t}`;
      persist(c);
      closeSheet();
      api.toast("跟进记录已添加", "success");
    });
    $m("mLogCancel").addEventListener("click", closeSheet);
  }

  /* ---------------- PAGE 3: contacts ---------------- */
  function renderContactsPage() {
    const c = api.state.customers[curIdx];
    if (!c) { showView("list"); return; }
    $m("mContactsTitle").textContent = (c.Company || "客户") + " · 联系方式";
    const today = api.todayStr();

    const list = (c._contacts || []).map((ct, i) => ({ ct, i, d: api.parseDate(ct.Com_Last) || new Date(0) }));
    list.sort((a, b) => b.d - a.d);

    let html = "";
    if (list.length === 0) {
      html = `<div class="m-empty">暂无联系方式<br><small>点击右上角 ＋ 添加</small></div>`;
    }
    for (const { ct, i } of list) {
      const clean = api.displayContactValue(ct.Contact);
      const detected = api.detectContactType(clean);
      const cl = api.fmtDate(ct.Com_Last);
      const isToday = cl === today;
      const isWa = String(ct.Type || "").toLowerCase() === "whatsapp" || detected === "WhatsApp";
      html += `<div class="m-card m-contact" data-i="${i}">
        <div class="m-contact-top">
          <span class="m-type-badge">${esc(ct.Type || detected)}</span>
          <span class="m-contact-name">${esc(ct.Name || "")}</span>
          <span class="m-status-chip ${esc(String(ct.Status || "").toLowerCase())}">${esc(ct.Status || "")}</span>
        </div>
        <div class="m-contact-value" title="点击复制">${esc(clean)}</div>
        <div class="m-contact-meta">
          <span class="${isToday ? "today" : ""}">最近: ${esc(cl || "—")}</span>
          <span>记录: ${esc(ct.Com_Records || "0r0")}</span>
        </div>
        <div class="m-btn-row">
          <button class="m-btn primary m-act" data-i="${i}">${isWa ? "💬 " : ""}联系</button>
          <button class="m-btn m-copy" data-i="${i}">复制</button>
          ${!isToday ? `<button class="m-btn m-mark" data-i="${i}">✓ 标记今日</button>` : `<span class="m-marked">✓ 今日已联系</span>`}
        </div>
      </div>`;
    }
    $m("mContactsBody").innerHTML = html;

    $m("mContactsBody").querySelectorAll(".m-contact-value").forEach(el => {
      el.addEventListener("click", () => copyText(el.textContent));
    });
    $m("mContactsBody").querySelectorAll(".m-copy").forEach(el => {
      el.addEventListener("click", () => {
        const ct = c._contacts[parseInt(el.dataset.i)];
        if (ct) copyText(api.displayContactValue(ct.Contact));
      });
    });
    // 联系 = desktop behavior: trigger external action + record today
    $m("mContactsBody").querySelectorAll(".m-act").forEach(el => {
      el.addEventListener("click", () => {
        const i = parseInt(el.dataset.i);
        const ct = c._contacts[i];
        if (!ct) return;
        api.triggerContactAction(ct.Contact, ct.Type);
        markContacted(c, i);
      });
    });
    // 标记今日 (no external action)
    $m("mContactsBody").querySelectorAll(".m-mark").forEach(el => {
      el.addEventListener("click", () => markContacted(c, parseInt(el.dataset.i)));
    });
  }

  function markContacted(c, i) {
    const ct = c._contacts[i];
    if (!ct) return;
    const today = api.todayStr();
    if (api.fmtDate(ct.Com_Last) === today) { api.toast("今日已联系过", "error"); return; }
    ct.Com_Last = today;
    ct.Com_Records = bumpPair(ct.Com_Records, true);
    c.Log = (c.Log || "") + `\n ${today}: 联系了 ${api.displayContactValue(ct.Contact)}`;
    persist(c);
    api.toast(`已记录今日联系: ${api.displayContactValue(ct.Contact)}`, "success");
  }

  function openAddContactSheet() {
    const c = api.state.customers[curIdx];
    if (!c) return;
    const types = (api.state.config.contactTypeList || []);
    openSheet(`
      <div class="m-sheet-title">添加联系方式</div>
      <label class="m-f-label">类型</label>
      <select class="m-f-input" id="mCType">${types.map(t => `<option ${t === "Email" ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <label class="m-f-label">联系方式</label>
      <input class="m-f-input" id="mCValue" placeholder="邮箱 / 电话 / 网址…" />
      <label class="m-f-label">联系人姓名（可选）</label>
      <input class="m-f-input" id="mCName" />
      <div class="m-btn-row sheet">
        <button class="m-btn primary" id="mCSave">添加</button>
        <button class="m-btn" id="mCCancel">取消</button>
      </div>`);
    $m("mCSave").addEventListener("click", () => {
      const v = $m("mCValue").value.trim();
      if (!v) { api.toast("请输入联系方式", "error"); return; }
      c._contacts.push({
        Type: $m("mCType").value, Contact: v, Name: $m("mCName").value.trim(),
        Status: "Active", Com_Last: "2000-01-01", Com_Records: "0r0",
      });
      persist(c);
      closeSheet();
      api.toast("联系方式已添加", "success");
    });
    $m("mCCancel").addEventListener("click", closeSheet);
  }

  /* ---------------- mode switch ---------------- */
  function applyMode(isMobile) {
    if (!api) return;
    document.body.classList.toggle("m-active", isMobile);
    $m("mApp").hidden = !isMobile;
    if (isMobile) renderCurrent();
  }

  /* ---------------- boot ---------------- */
  function boot() {
    if (booted) return;
    api = window.CFMS;
    if (!api) return;
    booted = true;

    document.body.insertAdjacentHTML("beforeend", ROOT_HTML);

    // list page events
    $m("mSearch").addEventListener("input", () => {
      mSearch = $m("mSearch").value.trim().toLowerCase();
      renderListPage();
    });
    $m("mBtnSettings").addEventListener("click", () => api.openConfigModal());
    // detail page events
    $m("mBtnBackList").addEventListener("click", () => showView("list"));
    // contacts page events
    $m("mBtnBackDetail").addEventListener("click", () => showView("detail"));
    $m("mBtnAddContact").addEventListener("click", openAddContactSheet);
    // sheet backdrop click-to-close (tap above sheet)
    $m("mSheetBackdrop").addEventListener("click", (e) => {
      if (e.target === $m("mSheetBackdrop")) closeSheet();
    });

    // data changes from app core (cloud pull, import, etc.)
    window.addEventListener("cfms:datachanged", () => { if (mq.matches) renderCurrent(); });

    applyMode(mq.matches);
    mq.addEventListener ? mq.addEventListener("change", (e) => applyMode(e.matches))
                        : mq.addListener((e) => applyMode(e.matches));
  }

  // app.js loads first, so CFMS exists when this runs — but data may still be loading;
  // listen for ready + fall back to direct boot.
  if (window.CFMS) boot();
  window.addEventListener("cfms:ready", boot);
  window.addEventListener("load", () => { if (window.CFMS) boot(); });
})();
