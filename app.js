/* ============================================================
   Customer Follow-up Management System — Web Edition V4
   Changes from V3:
   1. Working folder setting for auto-save
   2. Auto-save every 30 minutes (instead of 1 hour)
   3. Delete previous auto-save file after saving new one
   4. Multi-cloud support: Local / Google Drive / OneDrive
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

  const STORAGE_KEY = "cfms_data_v4";
  const CONFIG_KEY = "cfms_config_v4";

  /* V4 — IndexedDB persistence */
  const IDB_NAME = "cfms_db_v4";
  const IDB_STORE = "kv";
  let idb = null;

  /* V4 — Working folder auto-save */
  let workingDirHandle = null;
  const AUTO_SAVE_FILE = "客户总表_自动保存.xlsx";
  const AUTO_SAVE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  let autoSaveTimer = null;
  let lastAutoSaveTime = "";
  let currentAutoSaveFileName = ""; // Track current file to delete on next save
  const WORKING_DIR_HANDLE_KEY = "workingDirHandle";
  const LAST_SAVE_NAME_KEY = "lastAutoSaveName";

  /* ============================================================
     V4 — Cloud Storage Configuration
     ============================================================ */
  const CLOUD_STORAGE_KEY = "cfms_cloud_storage_v4";
  const GOOGLE_DRIVE_TOKEN_KEY = "google_drive_token";
  const ONEDRIVE_TOKEN_KEY = "onedrive_token";
  const GOOGLE_CONFIG_KEY = "google_drive_config";
  const ONEDRIVE_CONFIG_KEY = "onedrive_config";

  // Cloud storage provider configuration
  const CLOUD_CONFIG = {
    local: { name: "本地文件夹", icon: "📁" },
    google: { name: "Google Drive", icon: "☁️" },
    onedrive: { name: "OneDrive", icon: "🔷" },
  };

  // Current cloud storage state
  let cloudStorage = {
    provider: "local", // "local" | "google" | "onedrive"
    googleToken: null,
    onedriveToken: null,
    googleFolderId: null, // Google Drive folder ID
    onedriveFolderId: null, // OneDrive folder path
  };

  // User-configurable API credentials (stored in IndexedDB)
  let googleDriveConfig = {
    clientId: "",
    apiKey: "",
  };

  let onedriveConfig = {
    clientId: "",
  };

  // Google Drive API config
  const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];

  // OneDrive API config
  const ONEDRIVE_REDIRECT_URI = window.location.origin;
  const ONEDRIVE_SCOPES = ["Files.ReadWrite", "Files.ReadWrite.All"];

  /* ============================================================
     IndexedDB helpers
     ============================================================ */
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = (e) => { idb = e.target.result; resolve(idb); };
      req.onerror = (e) => reject(e.target.error);
    });
  }
  function idbPut(key, value) {
    return new Promise((resolve, reject) => {
      if (!idb) return resolve();
      const tx = idb.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  function idbGet(key) {
    return new Promise((resolve, reject) => {
      if (!idb) return resolve(undefined);
      const tx = idb.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbDel(key) {
    return new Promise((resolve, reject) => {
      if (!idb) return resolve();
      const tx = idb.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ============================================================
     V4 — Cloud Storage Helpers
     ============================================================ */
  async function loadCloudStorageState() {
    try {
      const saved = await idbGet(CLOUD_STORAGE_KEY);
      if (saved) {
        cloudStorage.provider = saved.provider || "local";
        cloudStorage.googleFolderId = saved.googleFolderId || null;
        cloudStorage.onedriveFolderId = saved.onedriveFolderId || null;
      }
      // Load tokens
      const googleToken = await idbGet(GOOGLE_DRIVE_TOKEN_KEY);
      if (googleToken && googleToken.expires_at > Date.now()) {
        cloudStorage.googleToken = googleToken;
      }
      const onedriveToken = await idbGet(ONEDRIVE_TOKEN_KEY);
      if (onedriveToken && onedriveToken.expires_at > Date.now()) {
        cloudStorage.onedriveToken = onedriveToken;
      }
      // Load API configs
      const googleCfg = await idbGet(GOOGLE_CONFIG_KEY);
      if (googleCfg) {
        googleDriveConfig.clientId = googleCfg.clientId || "";
        googleDriveConfig.apiKey = googleCfg.apiKey || "";
      }
      const onedriveCfg = await idbGet(ONEDRIVE_CONFIG_KEY);
      if (onedriveCfg) {
        onedriveConfig.clientId = onedriveCfg.clientId || "";
      }
    } catch (e) {
      console.warn("Failed to load cloud storage state", e);
    }
  }

  async function saveCloudStorageState() {
    try {
      await idbPut(CLOUD_STORAGE_KEY, {
        provider: cloudStorage.provider,
        googleFolderId: cloudStorage.googleFolderId,
        onedriveFolderId: cloudStorage.onedriveFolderId,
      });
    } catch (e) {
      console.warn("Failed to save cloud storage state", e);
    }
  }

  /* ============================================================
     V4 — Open File from Cloud Storage
     ============================================================ */
  async function openGoogleDriveFile() {
    if (!cloudStorage.googleToken || !cloudStorage.googleToken.access_token) {
      toast("请先登录 Google Drive", "error");
      return;
    }

    try {
      // List Excel files in Google Drive
      let query = "mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType='application/vnd.ms-excel'";
      if (cloudStorage.googleFolderId) {
        query += ` and '${cloudStorage.googleFolderId}' in parents`;
      }

      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=20`,
        {
          headers: {
            "Authorization": `Bearer ${cloudStorage.googleToken.access_token}`,
          },
        }
      );

      if (!response.ok) throw new Error("Failed to list files");

      const result = await response.json();
      if (!result.files || result.files.length === 0) {
        toast("Google Drive 中没有找到 Excel 文件", "error");
        return;
      }

      // Show file picker modal
      showCloudFilePicker(result.files, "Google Drive", async (file) => {
        // Download and import the file
        const downloadResponse = await fetch(
          `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
          {
            headers: {
              "Authorization": `Bearer ${cloudStorage.googleToken.access_token}`,
            },
          }
        );

        if (!downloadResponse.ok) throw new Error("Failed to download file");

        const blob = await downloadResponse.blob();
        const fileObj = new File([blob], file.name, { type: blob.type });
        importExcel(fileObj);
        toast(`已从 Google Drive 打开: ${file.name}`, "success");
      });
    } catch (e) {
      console.error("Open from Google Drive failed", e);
      toast("打开 Google Drive 文件失败: " + e.message, "error");
    }
  }

  async function openOneDriveFile() {
    if (!cloudStorage.onedriveToken || !cloudStorage.onedriveToken.access_token) {
      toast("请先登录 OneDrive", "error");
      return;
    }

    try {
      // List Excel files in OneDrive
      const accessToken = await getOneDriveToken();
      if (!accessToken) {
        toast("OneDrive token 获取失败", "error");
        return;
      }

      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/drive/root/children?$filter=file.mimeType eq 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or file.mimeType eq 'application/vnd.ms-excel'&$top=20&$orderby=lastModifiedDateTime desc`,
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) throw new Error("Failed to list files");

      const result = await response.json();
      if (!result.value || result.value.length === 0) {
        toast("OneDrive 中没有找到 Excel 文件", "error");
        return;
      }

      // Show file picker modal
      showCloudFilePicker(result.value, "OneDrive", async (file) => {
        // Download and import the file
        const downloadResponse = await fetch(
          `https://graph.microsoft.com/v1.0/me/drive/items/${file.id}/content`,
          {
            headers: {
              "Authorization": `Bearer ${accessToken}`,
            },
          }
        );

        if (!downloadResponse.ok) throw new Error("Failed to download file");

        const blob = await downloadResponse.blob();
        const fileObj = new File([blob], file.name, { type: blob.type });
        importExcel(fileObj);
        toast(`已从 OneDrive 打开: ${file.name}`, "success");
      });
    } catch (e) {
      console.error("Open from OneDrive failed", e);
      toast("打开 OneDrive 文件失败: " + e.message, "error");
    }
  }

  function showCloudFilePicker(files, providerName, onSelect) {
    const modal = document.createElement("div");
    modal.className = "modal-backdrop";
    modal.innerHTML = `
      <div class="modal" style="width: 500px; max-height: 70vh;">
        <div class="modal-header">
          <span class="modal-title">从 ${providerName} 打开</span>
          <button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">×</button>
        </div>
        <div class="modal-body" style="max-height: 50vh; overflow-y: auto;">
          ${files.map(f => `
            <div class="cloud-file-item" style="
              padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px;
              margin-bottom: 6px; cursor: pointer; display: flex; justify-content: space-between;
              align-items: center; transition: all 0.15s;
            ">
              <div>
                <div style="font-weight: 600; font-size: 13px;">📄 ${escapeHtml(f.name)}</div>
                <div style="font-size: 11px; color: var(--ink-faint);">
                  ${f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : ''}
                </div>
              </div>
              <button class="sbtn small">打开</button>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Bind click events
    modal.querySelectorAll(".cloud-file-item").forEach((item, i) => {
      item.onmouseover = () => item.style.background = "rgba(37,99,235,0.05)";
      item.onmouseout = () => item.style.background = "";
      item.querySelector(".sbtn").onclick = () => {
        modal.remove();
        onSelect(files[i]);
      };
    });

    // Close on backdrop click
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };
  }

  /* ============================================================
     V4 — Google Drive Integration
     ============================================================ */
  function isGoogleDriveConfigured() {
    return googleDriveConfig.clientId && googleDriveConfig.apiKey;
  }

  async function authenticateGoogleDrive() {
    if (!isGoogleDriveConfigured()) {
      toast("请先在配置中填写 Google Drive 的 Client ID 和 API Key", "error");
      return false;
    }

    const scopesStr = GOOGLE_SCOPES.join(" ");
    // Use full path including /crm/ subdirectory
    const redirectUri = window.location.origin + "/crm/";
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(googleDriveConfig.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=token` +
      `&scope=${encodeURIComponent(scopesStr)}` +
      `&prompt=consent`;

    // Check if we're returning from OAuth (token in URL hash)
    if (window.location.hash.includes("access_token")) {
      const params = new URLSearchParams(window.location.hash.substring(1));
      const accessToken = params.get("access_token");
      if (accessToken) {
        cloudStorage.googleToken = {
          access_token: accessToken,
          expires_at: Date.now() + (parseInt(params.get("expires_in")) || 3600) * 1000,
        };
        await idbPut(GOOGLE_DRIVE_TOKEN_KEY, cloudStorage.googleToken);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        toast("Google Drive 认证成功", "success");
        return true;
      }
    }

    // Detect if mobile browser
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (isMobile) {
      // Mobile: redirect in same window
      window.location.href = authUrl;
      return false; // Will reload page
    } else {
      // Desktop: try popup first, fallback to redirect
      try {
        const popup = window.open(authUrl, "googleAuth", "width=500,height=600");
        if (!popup || popup.closed) {
          // Popup blocked, use redirect
          window.location.href = authUrl;
          return false;
        }

        return new Promise((resolve) => {
          const authTimer = setInterval(() => {
            try {
              if (popup.closed) {
                clearInterval(authTimer);
                resolve(false);
                return;
              }
              const url = popup.location.href;
              if (url.includes("#") && url.includes("access_token")) {
                const params = new URLSearchParams(url.split("#")[1]);
                const accessToken = params.get("access_token");
                if (accessToken) {
                  cloudStorage.googleToken = {
                    access_token: accessToken,
                    expires_at: Date.now() + (parseInt(params.get("expires_in")) || 3600) * 1000,
                  };
                  idbPut(GOOGLE_DRIVE_TOKEN_KEY, cloudStorage.googleToken);
                  popup.close();
                  clearInterval(authTimer);
                  toast("Google Drive 认证成功", "success");
                  resolve(true);
                }
              }
            } catch (e) {
              // Cross-origin, waiting
            }
          }, 500);
        });
      } catch (e) {
        // Popup failed, use redirect
        window.location.href = authUrl;
        return false;
      }
    }
  }
    } catch (e) {
      console.error("Google Drive auth failed", e);
      toast("Google Drive 认证失败: " + e.message, "error");
      return false;
    }
  }

  // Check if token is expired
  function isTokenExpired(token) {
    if (!token || !token.expires_at) return true;
    return Date.now() >= token.expires_at - 300000; // 5 min buffer
  }

  async function googleDriveUpload(fileName, data) {
    if (!cloudStorage.googleToken || !cloudStorage.googleToken.access_token) {
      console.log("Google Drive token not found");
      return false;
    }

    if (isTokenExpired(cloudStorage.googleToken)) {
      console.log("Google Drive token expired");
      toast("Google Drive token 已过期，请重新登录", "error");
      return false;
    }

    try {
      // First, delete previous file if exists
      if (currentAutoSaveFileName) {
        await googleDriveDeleteFile(currentAutoSaveFileName);
      }

      // Create file metadata
      const metadata = {
        name: fileName,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };

      // If we have a folder ID, add it to metadata
      if (cloudStorage.googleFolderId) {
        metadata.parents = [cloudStorage.googleFolderId];
      }

      // Create form data
      const formData = new FormData();
      formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      formData.append("file", new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

      const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cloudStorage.googleToken.access_token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Google Drive upload error:", response.status, errorText);
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      console.log("Google Drive upload success:", result.id, result.name);
      currentAutoSaveFileName = fileName;
      await idbPut(LAST_SAVE_NAME_KEY, fileName);
      return true;
    } catch (e) {
      console.error("Google Drive upload failed:", e);
      return false;
    }
  }

  async function googleDriveDeleteFile(fileName) {
    if (!cloudStorage.googleToken || !cloudStorage.googleToken.access_token) return;

    try {
      // Search for the file by name - use simple query without special characters
      const searchResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name%3D%27${encodeURIComponent(fileName)}%27&fields=files(id)`,
        {
          headers: {
            "Authorization": `Bearer ${cloudStorage.googleToken.access_token}`,
          },
        }
      );

      if (searchResponse.ok) {
        const result = await searchResponse.json();
        if (result.files && result.files.length > 0) {
          for (const file of result.files) {
            await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
              method: "DELETE",
              headers: {
                "Authorization": `Bearer ${cloudStorage.googleToken.access_token}`,
              },
            });
            console.log("Deleted Google Drive file:", file.name);
          }
        }
      }
    } catch (e) {
      console.warn("Google Drive delete failed:", e);
    }
  }

  /* ============================================================
     V4 — OneDrive Integration
     ============================================================ */
  function isOneDriveConfigured() {
    return onedriveConfig.clientId;
  }

  let msalInstance = null;

  // Dynamically load MSAL library
  async function loadMsalLibrary() {
    if (typeof msal !== 'undefined') return true;
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js';
      script.onload = () => resolve(true);
      script.onerror = () => {
        console.warn('MSAL load failed');
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  async function authenticateOneDrive() {
    if (!isOneDriveConfigured()) {
      toast("请先在配置中填写 OneDrive 的 Client ID", "error");
      return false;
    }

    // Load MSAL library if not loaded
    const msalLoaded = await loadMsalLibrary();
    if (!msalLoaded || typeof msal === 'undefined') {
      toast("OneDrive 库加载失败，请检查网络连接后重试", "error");
      return false;
    }

    try {
      if (!msalInstance) {
        msalInstance = new msal.PublicClientApplication({
          auth: {
            clientId: onedriveConfig.clientId,
            redirectUri: ONEDRIVE_REDIRECT_URI,
          },
        });
      }

      const loginRequest = {
        scopes: ONEDRIVE_SCOPES,
      };

      const response = await msalInstance.loginPopup(loginRequest);
      cloudStorage.onedriveToken = {
        access_token: response.accessToken,
        expires_at: Date.now() + (response.expiresIn || 3600) * 1000,
      };
      await idbPut(ONEDRIVE_TOKEN_KEY, cloudStorage.onedriveToken);
      toast("OneDrive 认证成功", "success");
      return true;
    } catch (e) {
      console.error("OneDrive auth failed", e);
      if (e.errorCode !== "user_cancelled") {
        toast("OneDrive 认证失败: " + e.message, "error");
      }
      return false;
    }
  }

  async function getOneDriveToken() {
    if (!msalInstance) return null;

    const accounts = msalInstance.getAllAccounts();
    if (accounts.length === 0) return null;

    try {
      const response = await msalInstance.acquireTokenSilent({
        account: accounts[0],
        scopes: ONEDRIVE_SCOPES,
      });
      return response.accessToken;
    } catch (e) {
      // Silent acquisition failed, try popup
      try {
        const response = await msalInstance.acquireTokenPopup({
          scopes: ONEDRIVE_SCOPES,
        });
        return response.accessToken;
      } catch (e2) {
        console.error("OneDrive token refresh failed", e2);
        return null;
      }
    }
  }

  async function onedriveUpload(fileName, data) {
    const accessToken = await getOneDriveToken();
    if (!accessToken) {
      toast("请先登录 OneDrive", "error");
      return false;
    }

    try {
      // First, delete previous file if exists
      if (currentAutoSaveFileName) {
        await onedriveDeleteFile(currentAutoSaveFileName);
      }

      // Determine upload path
      const folderPath = cloudStorage.onedriveFolderId || "/Documents";
      const uploadPath = `${folderPath}/${fileName}`;

      // Upload file
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/drive/root:${uploadPath}:/content`,
        {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
          body: data,
        }
      );

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      currentAutoSaveFileName = fileName;
      await idbPut(LAST_SAVE_NAME_KEY, fileName);
      return true;
    } catch (e) {
      console.error("OneDrive upload failed", e);
      toast("OneDrive 上传失败: " + e.message, "error");
      return false;
    }
  }

  async function onedriveDeleteFile(fileName) {
    const accessToken = await getOneDriveToken();
    if (!accessToken) return;

    try {
      const folderPath = cloudStorage.onedriveFolderId || "/Documents";
      const filePath = `${folderPath}/${fileName}`;

      await fetch(
        `https://graph.microsoft.com/v1.0/me/drive/root:${filePath}`,
        {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
          },
        }
      );
    } catch (e) {
      console.warn("OneDrive delete failed (non-critical)", e);
    }
  }


  /* ============================================================
     CONTACT TYPE DETECTION (V2 — judges by content, not TYPE column)
     ============================================================ */
  function detectContactType(value) {
    const v = String(value || "").trim();
    if (!v) return "Others";
    // Email: standard email pattern
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Email";
    // Website: starts with http:// or https://
    if (/^https?:\/\//i.test(v)) return "Website";
    // Website without protocol: domain-like (e.g. example.com, www.example.com)
    // Must contain a dot, have no spaces, and look like a domain
    if (/^(www\.)?[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}(\/[^\s]*)?$/i.test(v)) return "Website";
    // Phone: mostly digits with +, spaces, dashes, parentheses, at least 7 chars
    if (/^[+]?[\d\s\-()]{7,}$/.test(v) && /\d{4,}/.test(v.replace(/[\s\-()]/g, ""))) return "Phone";
    // WhatsApp: often a long number with country code
    if (/^[+]\d{6,}$/.test(v.replace(/\s/g, ""))) return "WhatsApp";
    // Default
    return "Others";
  }

  function typeBadgeClass(type) {
    const t = String(type || "").toLowerCase();
    if (t === "email" || t === "e-mail") return "email";
    if (t === "website") return "website";
    if (t === "phone" || t === "whatsapp" || t === "wechat") return "phone";
    return "other";
  }

  function typeBadgeLetter(type) {
    const t = String(type || "").toLowerCase();
    if (t === "email" || t === "e-mail") return "@";
    if (t === "website") return "W";
    if (t === "whatsapp") return "WA";
    if (t === "phone" || t === "wechat") return "T";
    return "?";
  }

  /* ============================================================
     V2.4: Phone number formatting
     Storage keeps "|" prefix (prevents Excel float conversion).
     Display strips "|" and shows clean number with country code.
     ============================================================ */
  function displayContactValue(val) {
    let v = String(val || "");
    // Strip leading "|" (Excel text marker)
    if (v.startsWith("|")) v = v.slice(1);
    return v;
  }

  function storeContactValue(val) {
    let v = String(val || "").trim();
    if (!v) return v;
    // If it's a phone number (digits with optional + and separators) and doesn't start with |,
    // add | prefix to keep Excel from converting to float
    const detected = detectContactType(v);
    if ((detected === "Phone" || detected === "WhatsApp") && !v.startsWith("|")) {
      v = "|" + v;
    }
    return v;
  }

  /* ============================================================
     V2.4: WhatsApp integration — opens WhatsApp app/web
     ============================================================ */
  function openWhatsApp(rawValue) {
    // Extract digits for wa.me URL: strip |, +, spaces, dashes, parentheses
    let digits = String(rawValue || "").replace(/^\|/, "").replace(/[^\d]/g, "");
    if (!digits) { toast("无法识别 WhatsApp 号码", "error"); return; }
    // Copy to clipboard
    navigator.clipboard.writeText(rawValue.replace(/^\|/, "")).then(() => {}).catch(() => {});
    // Use https://wa.me/ — works on desktop (opens WhatsApp Web or app) and mobile
    const url = `https://wa.me/${digits}`;
    window.open(url, "_blank");
    toast(`已打开 WhatsApp（号码：${displayContactValue(rawValue)}）`, "success");
  }

  /* ============================================================
     EMAIL / WEBSITE ACTION (V2.1 — Foxmail + mailto)
     ============================================================ */
  function openEmailCompose(email) {
    // Copy to clipboard
    navigator.clipboard.writeText(email).then(() => {}).catch(() => {});
    // Use mailto: protocol — opens system default mail client (Foxmail)
    const c = state.customers[state.currentIdx];
    const subject = c && c.Company ? `${c.Company} — 跟进` : "客户跟进";
    const mailtoUrl = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}`;
    window.location.href = mailtoUrl;
    toast(`邮箱已复制 · 已打开 Foxmail 写信（收件人：${email}）`, "success");
  }

  function openWebsite(url) {
    let u = String(url).trim();
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    window.open(u, "_blank");
    toast("已打开网站", "success");
  }

  // V2.4: Unified contact action — decides by detected type AND Type column
  function triggerContactAction(contactValue, typeColumn) {
    const rawVal = String(contactValue || "").trim();
    if (!rawVal || rawVal === "new_contact") return;
    const cleanVal = displayContactValue(rawVal);
    const detected = detectContactType(cleanVal);
    const typeLower = String(typeColumn || "").toLowerCase();

    if (detected === "Email") {
      openEmailCompose(cleanVal);
    } else if (detected === "Website") {
      openWebsite(cleanVal);
    } else if (typeLower === "whatsapp" || detected === "WhatsApp") {
      openWhatsApp(rawVal);
    }
    // Phone (non-WhatsApp) / Others: no external action (just mark contact)
  }

  /* ============================================================
     STATE
     ============================================================ */
  const state = {
    customers: [],
    currentIdx: -1,
    filteredIdx: [],
    filterPage: 0,
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
     CONTACTS SERIALIZATION
     ============================================================ */
  function parseContactsString(str) {
    if (!str) return [];
    const cleaned = String(str).replace(/\r/g, "");
    const parts = cleaned.split(/\n|;|\t/).map(s => s.trim()).filter(Boolean);
    const contacts = [];
    for (const part of parts) {
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
    c._contacts = parseContactsString(c.Contacts);
    if (!c.ID || String(c.ID).trim() === "") {
      c.ID = genId() + " " + (c.Region || "未知地区") + " " + (c.Category || "未知品类") + " " + (c.Company || "未知公司");
    }
    autoSetDates(c);
    return c;
  }

  function autoSetDates(c) {
    const today = todayStr();
    if (!parseDate(c.Set)) c.Set = today;
    else c.Set = fmtDate(c.Set);
    let nearest = null;
    for (const ct of c._contacts) {
      const d = parseDate(ct.Com_Last);
      if (d) {
        if (!nearest || Math.abs(d - new Date()) < Math.abs(nearest - new Date())) nearest = d;
      }
    }
    c.Last = nearest ? nearest.toISOString().slice(0, 10) : "2000-01-01";
    const nextDate = parseDate(c.Next);
    const rating = c.Rating || "普通";
    const offset = state.config.ratingOffset[rating] != null ? state.config.ratingOffset[rating] : 30;
    if (!nextDate || nextDate <= new Date(today)) {
      const contactedToday = c._contacts.some(ct => {
        const d = parseDate(ct.Com_Last);
        return d && d >= new Date(today);
      });
      if (contactedToday) {
        c.Next = addDays(today, offset);
      } else if (!nextDate) {
        c.Next = today;
      }
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
     EXCEL IMPORT / EXPORT
     ============================================================ */
  function importExcel(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        const result = { customers: [], config: null, newList: [], convertList: [] };
        if (wb.SheetNames.includes("config")) {
          const ws = wb.Sheets["config"];
          const cfgArr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          result.config = parseConfigSheet(cfgArr);
        }
        const mainName = wb.SheetNames.find(n => /^Sheet1$/i.test(n)) || wb.SheetNames[0];
        if (mainName) {
          const ws = wb.Sheets[mainName];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
          result.customers = rows.map((r, i) => normalizeCustomer(r, i));
        }
        if (wb.SheetNames.includes("NewList")) {
          const ws = wb.Sheets["NewList"];
          result.newList = XLSX.utils.sheet_to_json(ws, { defval: "" });
        }
        if (wb.SheetNames.includes("ConvertList")) {
          const ws = wb.Sheets["ConvertList"];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          result.convertList = raw;
        }
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

  function buildWorkbook() {
    const wb = XLSX.utils.book_new();
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
    const wsNew = XLSX.utils.json_to_sheet([], { header: CUSTOMER_COLUMNS });
    XLSX.utils.book_append_sheet(wb, wsNew, "NewList");
    // V2.4: ConvertList — include exported combined rows if any
    const convHeaders = [...CONTACT_COLUMNS, ...CUSTOMER_COLUMNS.filter(c => c !== "Contacts")];
    const wsConv = XLSX.utils.json_to_sheet(state._convertList || [], { header: convHeaders });
    XLSX.utils.book_append_sheet(wb, wsConv, "ConvertList");
    return wb;
  }

  /* ============================================================
     V2.4: Export filtered customers to ConvertList
     Each contact becomes a row, with customer info repeated.
     ============================================================ */
  function exportToConvertList() {
    if (state.filteredIdx.length === 0) {
      toast("没有筛选出的客户可导出", "error");
      return;
    }
    const convRows = [];
    const customerCols = CUSTOMER_COLUMNS.filter(c => c !== "Contacts");
    for (const idx of state.filteredIdx) {
      const c = state.customers[idx];
      for (const ct of c._contacts) {
        const row = {};
        // contact columns first
        for (const col of CONTACT_COLUMNS) row[col] = ct[col] != null ? ct[col] : "";
        // customer columns (except Contacts)
        for (const col of customerCols) {
          if (col === "Index") row[col] = "";
          else row[col] = c[col] != null ? c[col] : "";
        }
        convRows.push(row);
      }
    }
    state._convertList = convRows;
    saveToLocal();
    toast(`已导出 ${state.filteredIdx.length} 个客户（${convRows.length} 条联系方式）到 ConvertList`, "success");
    // Also trigger Excel download so user has the file
    const wb = buildWorkbook();
    const ts = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `客户总表_ConvertList_${ts}.xlsx`);
  }

  function exportExcel() {
    if (state.customers.length === 0) {
      toast("没有数据可导出", "error");
      return;
    }
    const wb = buildWorkbook();
    const ts = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `客户总表_${ts}.xlsx`);
    toast("Excel 已导出", "success");
  }

  /* ============================================================
     PERSISTENCE — IndexedDB
     ============================================================ */
  function saveToLocal() {
    if (!idb) return;
    const slim = state.customers.map(c => {
      const out = {};
      for (const col of CUSTOMER_COLUMNS) out[col] = c[col];
      return out;
    });
    idbPut("customers", {
      customers: slim,
      fileName: state.fileName,
      savedAt: new Date().toISOString(),
    }).catch(e => console.warn("IDB save failed", e));
  }

  async function loadFromLocal() {
    if (!idb) return false;
    try {
      const obj = await idbGet("customers");
      if (!obj || !obj.customers || obj.customers.length === 0) return false;
      state.customers = obj.customers.map((r, i) => normalizeCustomer(r, i));
      state.fileName = obj.fileName || "(本地存档)";
      state.currentIdx = 0;
      state.filteredIdx = state.customers.map((_, i) => i);
      $("lastSaved").textContent = "本地存档 · " + (obj.savedAt ? new Date(obj.savedAt).toLocaleString() : "");
      return true;
    } catch (e) { console.warn("IDB load failed", e); return false; }
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
            <span class="sub-title">联系方式</span>
            <div class="sub-actions">
              <button class="sbtn small" id="addContact">+ 添加</button>
            </div>
          </div>
          <div class="contacts-table" id="contactsTable">
            <div class="contacts-row header">
              <div>Type</div><div>Contact</div><div>Name</div><div>Status</div>
              <div>Com_Last</div><div>Records</div><div>联系</div><div></div>
            </div>
            ${renderContactsRows(c)}
          </div>
          <div style="font-size:11px;color:var(--ink-faint);margin-top:4px;line-height:1.6;">
            <b style="color:var(--ink-dim)">操作提示：</b><br>
            • <span style="color:var(--accent)">点击「联系」按钮</span>：邮箱→Foxmail 写信，网址→打开网站，号码→仅标记；同时自动标记今日联系（Com_Last + Records 更新）<br>
            • <span style="color:var(--accent)">双击 Contact / Name</span>：进入编辑<br>
            • <span style="color:var(--accent)">双击 Type / Status</span>：循环切换值<br>
            • <span style="color:var(--accent)">双击 Com_Last</span>：标记今日联系 · <span style="color:var(--accent)">双击 Records</span>：标记获得回复<br>
            • <span style="color:var(--accent)">添加联系方式</span>：自动识别邮箱/网址/号码类型 · 内容过长自动省略，悬停可查看完整内容
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
    // V2.2: display-layer sort by Com_Last desc (most recent first).
    const indexed = c._contacts.map((ct, i) => ({
      ct, i,
      d: parseDate(ct.Com_Last) || new Date(0),
    }));
    indexed.sort((a, b) => b.d - a.d);
    return indexed.map(({ ct, i }) => {
      const cl = fmtDate(ct.Com_Last);
      const isToday = cl === today;
      const cleanVal = displayContactValue(ct.Contact);
      const detectedType = detectContactType(cleanVal);
      const badgeCls = typeBadgeClass(detectedType);
      const badgeLetter = typeBadgeLetter(detectedType);
      const textCls = badgeCls;
      // V2.4: WhatsApp badge if Type column says WhatsApp
      const typeLower = String(ct.Type || "").toLowerCase();
      const isWhatsApp = typeLower === "whatsapp";
      const actionTitle = detectedType === "Email"
        ? "联系：Foxmail 写信 + 标记今日联系"
        : detectedType === "Website"
        ? "联系：打开网站 + 标记今日联系"
        : isWhatsApp
        ? "联系：打开 WhatsApp + 标记今日联系"
        : "联系：标记今日联系";
      const btnIcon = detectedType === "Email"
        ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M4 4l8 7 8-7"/></svg>`
        : detectedType === "Website"
        ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`
        : isWhatsApp
        ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`
        : `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
      return `<div class="contacts-row" data-i="${i}">
        <div class="c-type" data-i="${i}" title="${escapeHtml(ct.Type)}">${escapeHtml(ct.Type)}</div>
        <div class="c-contact" data-i="${i}" title="${escapeHtml(cleanVal)}">
          <div class="c-contact-wrap">
            <span class="c-type-badge ${badgeCls}" title="${escapeHtml(detectedType)}">${badgeLetter}</span>
            <span class="c-contact-text ${textCls}" title="${escapeHtml(cleanVal)}">${escapeHtml(cleanVal)}</span>
          </div>
        </div>
        <div class="c-name" data-i="${i}" title="${escapeHtml(ct.Name)}">${escapeHtml(ct.Name)}</div>
        <div class="c-status" data-i="${i}" title="${escapeHtml(ct.Status)}">${escapeHtml(ct.Status)}</div>
        <div class="c-comlast ${isToday ? "contact-today" : ""}" data-i="${i}">${escapeHtml(cl)}</div>
        <div class="c-comrecords" data-i="${i}">${escapeHtml(ct.Com_Records)}</div>
        <div class="c-contactbtn ${isToday ? "contact-today" : ""}" data-i="${i}" title="${escapeHtml(actionTitle)}">${btnIcon}</div>
        <div class="c-del" data-i="${i}" title="删除">×</div>
      </div>`;
    }).join("");
  }

  /* ============================================================
     DETAIL EVENT BINDING  (V2 — contacts module changed)
     ============================================================ */
  function bindDetailEvents(c) {
    // Field inputs — live update on change
    document.querySelectorAll(".field-input[data-col]").forEach(el => {
      el.addEventListener("change", () => {
        const col = el.dataset.col;
        c[col] = el.value;
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

    // V2: Add contact — inline input with auto-type-detection
    $("addContact").addEventListener("click", () => {
      addContactInline(c);
    });

    // V2: Contacts table interactions
    const table = $("contactsTable");

    // V2.3: click handler — "联系" button triggers open + marks today's contact.
    table.addEventListener("click", (e) => {
      // "联系" button
      const btnEl = e.target.closest(".c-contactbtn");
      if (btnEl) {
        const i = parseInt(btnEl.dataset.i);
        const ct = c._contacts[i];
        if (!ct) return;
        // 1) trigger the contact action (email/website/WhatsApp) via unified handler
        triggerContactAction(ct.Contact, ct.Type);
        // 2) mark today's contact (same as dblclick on Com_Last)
        const today = todayStr();
        const cur = fmtDate(ct.Com_Last);
        const displayVal = displayContactValue(ct.Contact);
        if (cur !== today) {
          ct.Com_Last = today;
          ct.Com_Records = bumpPair(ct.Com_Records, true);
          c.Log = (c.Log || "") + `\n ${today}: 联系了 ${displayVal}`;
          $("logArea").value = c.Log;
          toast(`已记录今日联系: ${displayVal}`, "success");
        } else {
          toast("今日已联系过", "error");
        }
        syncContactsToCustomer(c);
        state.dirty = true;
        renderDetail();
        renderList();
        return;
      }
      // Delete contact (single click on ×)
      if (e.target.classList.contains("c-del")) {
        const i = parseInt(e.target.dataset.i);
        c._contacts.splice(i, 1);
        syncContactsToCustomer(c);
        state.dirty = true;
        renderDetail();
      }
    });

    // DOUBLE CLICK — V2: Contact/Name only edit; Type/Status/Com_Last/Records unchanged
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
        ct.Com_Last = todayStr();
        ct.Com_Records = bumpPair(ct.Com_Records, false);
        c.Log = (c.Log || "") + `\n ${todayStr()}: 获得 ${ct.Contact} 的回复`;
        $("logArea").value = c.Log;
        toast(`已记录回复: ${ct.Contact}`, "success");
      } else if (cls.includes("c-contact")) {
        // V2: only edit, no copy
        inlineEditContact(target, ct, () => {
          syncContactsToCustomer(c);
          state.dirty = true;
          renderDetail();
        });
        return;
      } else if (cls.includes("c-name")) {
        // V2: only edit, no copy
        inlineEdit(target, ct, "Name", () => {
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

  /* ============================================================
     V2: Add contact with inline input + auto type detection
     ============================================================ */
  function addContactInline(c) {
    // Create a temporary row with an input field
    const table = $("contactsTable");
    const newRow = document.createElement("div");
    newRow.className = "contacts-row";
    newRow.innerHTML = `
      <div class="c-type" style="color:var(--ink-faint)">?</div>
      <div class="c-contact" style="padding:2px;">
        <input type="text" class="contact-add-input" placeholder="输入邮箱/网址/号码，自动识别类型…" />
      </div>
      <div class="c-name"></div>
      <div class="c-status">Active</div>
      <div class="c-comlast">2000-01-01</div>
      <div class="c-comrecords">0r0</div>
      <div class="c-del" title="取消">×</div>
    `;
    table.appendChild(newRow);
    const input = newRow.querySelector(".contact-add-input");
    const typeCell = newRow.querySelector(".c-type");
    input.focus();

    const commit = () => {
      const val = input.value.trim();
      if (!val) {
        newRow.remove();
        return;
      }
      // V2: auto-detect type from content
      const detected = detectContactType(val);
      // Map detected type to config type list
      let typeStr = "Others";
      if (detected === "Email") typeStr = "Email";
      else if (detected === "Website") typeStr = "Website";
      else if (detected === "Phone") typeStr = "Phone";
      else if (detected === "WhatsApp") typeStr = "WhatsApp";

      // If the detected type isn't in the config list, add "Others"
      if (!state.config.contactTypeList.includes(typeStr)) {
        typeStr = state.config.contactTypeList[0] || "Email";
      }

      c._contacts.push({
        Type: typeStr,
        Contact: storeContactValue(val),
        Name: "new_name",
        Status: "Active",
        Com_Last: "2000-01-01",
        Com_Records: "0r0",
      });
      syncContactsToCustomer(c);
      state.dirty = true;
      renderDetail();
      toast(`已添加联系方式，自动识别类型：${detected}`, "success");
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { newRow.remove(); }
    });
    input.addEventListener("blur", () => {
      // small delay to allow Enter to process
      setTimeout(() => {
        if (document.body.contains(newRow)) commit();
      }, 100);
    });
    // Live preview of detected type
    input.addEventListener("input", () => {
      const val = input.value.trim();
      if (val) {
        const detected = detectContactType(val);
        const cls = typeBadgeClass(detected);
        typeCell.innerHTML = `<span class="c-type-badge ${cls}">${typeBadgeLetter(detected)}</span> <span style="font-size:10px;color:var(--ink-faint)">${detected}</span>`;
      } else {
        typeCell.textContent = "?";
        typeCell.style.color = "var(--ink-faint)";
      }
    });
    // Cancel button
    newRow.querySelector(".c-del").addEventListener("click", () => newRow.remove());
  }

  /* ============================================================
     V2: Inline edit for Contact (with auto-type re-detection on commit)
     ============================================================ */
  function inlineEditContact(el, ct, onDone) {
    const oldVal = ct.Contact;
    const wrap = el.querySelector(".c-contact-wrap") || el;
    const input = document.createElement("input");
    input.type = "text";
    input.value = oldVal;
    input.className = "contact-add-input";
    el.innerHTML = "";
    el.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      ct.Contact = storeContactValue(input.value.trim() || oldVal);
      onDone();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = oldVal; input.blur(); }
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
     SAVE CURRENT CUSTOMER
     ============================================================ */
  function saveCurrentCustomer() {
    if (state.currentIdx < 0) {
      toast("没有选中客户", "error");
      return;
    }
    const c = state.customers[state.currentIdx];
    if (!c.ID || String(c.ID).trim() === "") {
      c.ID = genId() + " " + (c.Region || "未知地区") + " " + (c.Category || "未知品类") + " " + (c.Company || "未知公司");
    }
    syncContactsToCustomer(c);
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
     V3: Region / country detection from free text
     ============================================================ */
  const REGION_ALIASES = {
    "澳大利亚": ["australia", "australian"],
    "肯尼亚": ["kenya", "kenyan"],
    "南非": ["south africa", "south-african"],
    "美国": ["united states", "usa", "u.s.a", "america", "american"],
    "新加坡": ["singapore", "singaporean"],
    "厄瓜多尔": ["ecuador", "ecuadorian"],
    "巴西": ["brazil", "brazilian"],
    "印度": ["india", "indian"],
    "意大利": ["italy", "italian", "italia"],
    "苏丹": ["sudan"],
    "俄罗斯": ["russia", "russian"],
    "墨西哥": ["mexico", "mexican"],
    "英国": ["united kingdom", "britain", "british", "england"],
    "阿联酋": ["uae", "united arab emirates", "dubai", "emirates"],
    "土耳其": ["turkey", "turkish", "türkiye"],
  };

  function detectRegion(text, regionList) {
    if (!regionList || !regionList.length) return "";
    const lower = text.toLowerCase();
    // 1) Chinese region name appears directly in text
    for (const r of regionList) {
      if (r === "全部") continue;
      if (lower.includes(r.toLowerCase())) return r;
    }
    // 2) English alias (word-boundary match to avoid false substrings)
    for (const r of regionList) {
      if (r === "全部") continue;
      const aliases = REGION_ALIASES[r] || [];
      for (const a of aliases) {
        const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp("\\b" + esc + "\\b", "i").test(text)) return r;
      }
    }
    return "";
  }

  /* ============================================================
     V2.5: Clipboard smart parse — auto-fill new customer
     ============================================================ */
  async function parseClipboardForCustomer() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      return null;
    }
    if (!text || !text.trim()) return null;

    const result = { emails: [], phones: [], websites: [], company: "", region: "" };

    // 1. Extract emails
    const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    result.emails = [...new Set(text.match(emailRe) || [])];
    let remaining = text.replace(emailRe, " ");

    // 2. Extract URLs with protocol
    const urlRe = /https?:\/\/[^\s<>"']+/gi;
    const urlsWithProto = [...new Set(remaining.match(urlRe) || [])];
    remaining = remaining.replace(urlRe, " ");

    // 3. Extract bare domains
    const domainRe = /(?:www\.)?[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?(?:\/[^\s]*)?/gi;
    const bareDomains = [...new Set(remaining.match(domainRe) || [])];
    const filteredDomains = bareDomains.filter(d => {
      const parts = d.split(".");
      if (parts.length < 2) return false;
      const before = parts[0].toLowerCase();
      if (before === "www") return parts.length >= 3;
      return before.length >= 2;
    });
    remaining = remaining.replace(domainRe, " ");
    result.websites = [...urlsWithProto, ...filteredDomains];

    // 4. Extract phone numbers
    const phoneRe = /\+?[\d][\d\s\-()]{5,}\d/g;
    const rawPhones = remaining.match(phoneRe) || [];
    result.phones = [...new Set(rawPhones.map(p => p.trim()).filter(p => {
      const digits = p.replace(/[^\d]/g, "");
      return digits.length >= 7;
    }))];

    // 5. Try to find company name
    let foundCompany = "";
    const labelRe = /(?:公司名称?|企业名称?|客户|公司|Company\s*Name|Company|企业|Firm|Business)\s*[:：]\s*([^\n\r]+)/i;
    const labelMatch = text.match(labelRe);
    if (labelMatch) {
      let v = labelMatch[1].replace(/\s+/g, " ").trim();
      v = v.split(/\s[-–—|]\s|\s*(?:电话|手机|邮箱|Email|Phone|Tel|Address|地址|Website|网址|WhatsApp)\s*[:：]/i)[0].trim();
      if (v.length > 0 && v.length < 120) foundCompany = v;
    }
    if (!foundCompany) {
      const lines = text.split(/[\n\r]/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) continue;
        if (/^https?:\/\//i.test(line)) continue;
        if (/^[\d\s\-+()]+$/.test(line)) continue;
        if (/(Ltd\.?|LLC|Inc\.?|Corp\.?|GmbH|S\.A\.|Co\.?,?|Limited|Corporation|Company|Group|集团|有限公司|股份公司|有限责任公司)/i.test(line) && line.length < 120) {
          foundCompany = line;
          break;
        }
      }
    }
    if (!foundCompany) {
      let domainForCompany = "";
      if (result.emails.length > 0) {
        domainForCompany = result.emails[0].split("@")[1] || "";
      } else if (result.websites.length > 0) {
        let w = result.websites[0].replace(/^https?:\/\//i, "").replace(/^www\./i, "");
        domainForCompany = w.split("/")[0] || "";
      }
      if (domainForCompany) {
        const parts = domainForCompany.split(".");
        let name = parts[0];
        if (parts.length >= 3 && parts[0].toLowerCase() === "www") name = parts[1];
        else if (parts.length >= 2) name = parts[parts.length - 2];
        name = name.replace(/[-_.]/g, " ").trim();
        if (name && name.length >= 2) {
          name = name.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          foundCompany = name;
        }
      }
    }
    result.company = foundCompany;
    result.region = detectRegion(text, state.config.regionList);

    const hasData = result.emails.length > 0 || result.phones.length > 0 ||
                     result.websites.length > 0 || result.company || result.region;
    if (!hasData) return null;
    return result;
  }

  /* ============================================================
     NEW CUSTOMER (V2.5 — clipboard auto-fill)
     ============================================================ */
  async function newCustomer() {
    let clipData = null;
    try {
      clipData = await parseClipboardForCustomer();
    } catch (e) { /* ignore clipboard errors */ }

    const template = state.currentIdx >= 0 ? state.customers[state.currentIdx] : null;
    const contacts = [];
    let company = "";
    let website = "";
    let region = "";

    if (clipData) {
      company = clipData.company;
      region = clipData.region;
      if (clipData.websites.length > 0) website = clipData.websites[0];
      for (const email of clipData.emails) {
        contacts.push({
          Type: "Email", Contact: email, Name: "new_name",
          Status: "Active", Com_Last: "2000-01-01", Com_Records: "0r0",
        });
      }
      for (const phone of clipData.phones) {
        contacts.push({
          Type: "Phone", Contact: storeContactValue(phone), Name: "new_name",
          Status: "Active", Com_Last: "2000-01-01", Com_Records: "0r0",
        });
      }
      for (const w of clipData.websites) {
        contacts.push({
          Type: "Website", Contact: w, Name: "new_name",
          Status: "Active", Com_Last: "2000-01-01", Com_Records: "0r0",
        });
      }
    }

    const c = {
      Index: state.customers.length + 1,
      ID: "",
      Contacts: "",
      Rating: template ? template.Rating : "普通",
      Set: todayStr(),
      Last: todayStr(),
      Next: todayStr(),
      Address: "",
      Company: company,
      Website: website,
      Category: template ? template.Category : "",
      Region: region || (template ? template.Region : ""),
      From: template ? template.From : "",
      Log: "",
      _contacts: contacts,
      _isNew: true,
    };
    state.customers.push(c);
    state.currentIdx = state.customers.length - 1;
    state.filteredIdx = state.customers.map((_, i) => i);
    state.filterPage = state.filteredIdx.length - 1;
    saveToLocal();
    renderAll();

    if (clipData) {
      const parts = [];
      if (company) parts.push(`公司: ${company}`);
      if (clipData.emails.length) parts.push(`${clipData.emails.length}个邮箱`);
      if (clipData.phones.length) parts.push(`${clipData.phones.length}个电话`);
      if (clipData.websites.length) parts.push(`${clipData.websites.length}个网址`);
      if (region) parts.push(`地区: ${region}`);
      toast(`已从剪贴板自动填充：${parts.join("，")}`, "success");
    } else {
      toast("已创建新客户，请填写信息后保存", "success");
    }
  }

  /* ============================================================
     BATCH IMPORT
     ============================================================ */
  function batchImport() {
    if (!state._newList || state._newList.length === 0) {
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
     BATCH UPDATE
     ============================================================ */
  function batchUpdate() {
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
        <h4>邮箱服务</h4>
        <div style="padding:8px 10px;background:rgba(0,0,0,0.2);border-radius:6px;border:1px solid var(--border);font-size:12px;color:var(--ink-dim);line-height:1.6;">
          当前使用 <b style="color:var(--accent)">mailto 协议</b>（调用系统默认邮件客户端 Foxmail 打开写信窗口）<br>
          <span style="color:var(--ink-faint)">如需切换默认客户端，请在 Windows 设置 → 应用 → 默认应用 → 邮件 中修改</span>
        </div>
      </div>
      <div class="cfg-section">
        <h4>自动保存（每30分钟）</h4>
        <div class="backup-status" id="backupStatus"></div>
        <div class="backup-actions" id="backupActions"></div>
      </div>

      <!-- Google Drive 配置 -->
      <div class="cfg-section" id="googleDriveConfigSection" style="display:none;">
        <h4>☁️ Google Drive 配置</h4>
        <div style="padding:10px;background:rgba(30,50,90,0.03);border-radius:6px;border:1px solid var(--border);">
          <div style="margin-bottom:10px;">
            <label style="font-weight:700;font-size:12px;color:var(--ink);">Client ID</label>
            <input type="text" id="googleClientId" class="field-input" placeholder="xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxx.apps.googleusercontent.com" style="margin-top:4px;" />
          </div>
          <div style="margin-bottom:10px;">
            <label style="font-weight:700;font-size:12px;color:var(--ink);">API Key</label>
            <input type="text" id="googleApiKey" class="field-input" placeholder="AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXX" style="margin-top:4px;" />
          </div>
          <div style="font-size:11px;color:var(--ink-dim);line-height:1.6;background:#fff;padding:8px;border-radius:4px;border:1px solid var(--border);">
            <b style="color:var(--accent);">获取步骤：</b><br>
            1. 访问 <a href="https://console.cloud.google.com/" target="_blank" style="color:var(--accent);">Google Cloud Console</a><br>
            2. 创建项目（或选择已有项目）<br>
            3. 点击「API和服务」→「凭据」→「创建凭据」→「OAuth 客户端 ID」<br>
            4. 应用类型选择「网页应用」<br>
            5. 在「已获准的重定向 URI」中添加：<code style="background:rgba(37,99,235,0.1);padding:1px 4px;border-radius:3px;">${window.location.origin}</code><br>
            6. 复制 Client ID 和 API Key 填入上方
          </div>
          <button class="sbtn small" id="saveGoogleConfig" style="margin-top:8px;">保存 Google Drive 配置</button>
        </div>
      </div>

      <!-- OneDrive 配置 -->
      <div class="cfg-section" id="oneDriveConfigSection" style="display:none;">
        <h4>🔷 OneDrive 配置</h4>
        <div style="padding:10px;background:rgba(30,50,90,0.03);border-radius:6px;border:1px solid var(--border);">
          <div style="margin-bottom:10px;">
            <label style="font-weight:700;font-size:12px;color:var(--ink);">Application (Client) ID</label>
            <input type="text" id="onedriveClientId" class="field-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="margin-top:4px;" />
          </div>
          <div style="font-size:11px;color:var(--ink-dim);line-height:1.6;background:#fff;padding:8px;border-radius:4px;border:1px solid var(--border);">
            <b style="color:var(--accent);">获取步骤：</b><br>
            1. 访问 <a href="https://portal.azure.com/" target="_blank" style="color:var(--accent);">Azure Portal</a><br>
            2. 点击「Azure Active Directory」→「应用注册」→「新注册」<br>
            3. 名称填写「Customer Management Web」<br>
            4. 重定向 URI 选择「Web」，填写：<code style="background:rgba(37,99,235,0.1);padding:1px 4px;border-radius:3px;">${window.location.origin}</code><br>
            5. 点击「注册」<br>
            6. 复制「Application (Client) ID」填入上方<br>
            7. 点击「证书和密码」→「新建客户端密码」→ 设置密码并记录（可选）
          </div>
          <button class="sbtn small" id="saveOnedriveConfig" style="margin-top:8px;">保存 OneDrive 配置</button>
        </div>
      </div>
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

    // V4: cloud storage buttons
    updateWorkingFolderStatusUI();
    updateCloudButtons();

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
     V4: AUTO-SAVE — File System Access API
     Working folder: saves Excel every 30 minutes, deletes previous file
     ============================================================ */
  function fsaSupported() {
    return typeof window.showDirectoryPicker === "function";
  }

  async function pickWorkingFolder() {
    if (!fsaSupported()) {
      toast("当前浏览器不支持选择文件夹自动保存（建议用 Chrome/Edge）", "error");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      workingDirHandle = handle;
      await idbPut(WORKING_DIR_HANDLE_KEY, handle);
      toast(`已选择工作文件夹：${handle.name}，每30分钟自动保存一次`, "success");
      updateWorkingFolderStatusUI();
    } catch (e) {
      // user cancelled
    }
  }

  async function clearWorkingFolder() {
    workingDirHandle = null;
    await idbDel(WORKING_DIR_HANDLE_KEY);
    currentAutoSaveFileName = "";
    await idbDel(LAST_SAVE_NAME_KEY);
    toast("已取消自动保存", "success");
    updateWorkingFolderStatusUI();
  }

  async function restoreWorkingFolderHandle() {
    if (!idb) return;
    try {
      const h = await idbGet(WORKING_DIR_HANDLE_KEY);
      if (h) workingDirHandle = h;
      const lastFile = await idbGet(LAST_SAVE_NAME_KEY);
      if (lastFile) currentAutoSaveFileName = lastFile;
    } catch (e) { /* handle may be stale */ }
  }

  async function ensureWorkingFolderPermission() {
    if (!workingDirHandle) return false;
    let perm = await workingDirHandle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") return true;
    try {
      perm = await workingDirHandle.requestPermission({ mode: "readwrite" });
    } catch (e) {}
    return perm === "granted";
  }

  async function deletePreviousAutoSave() {
    if (!workingDirHandle || !currentAutoSaveFileName) return;
    try {
      await workingDirHandle.removeEntry(currentAutoSaveFileName);
    } catch (e) {
      // File may not exist yet, that's fine
    }
  }

  async function runAutoSave(silent) {
    if (!state.dirty && currentAutoSaveFileName) {
      if (!silent) toast("数据无更新，无需保存", "success");
      return;
    }

    // Generate new filename with timestamp
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const newFileName = `客户总表_自动保存_${ts}.xlsx`;

    // Build workbook and save
    const wb = buildWorkbook();
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const savedLocations = [];
    const failedLocations = [];

    // 1. Save to local folder (if available)
    if (workingDirHandle) {
      try {
        const ok = await ensureWorkingFolderPermission();
        if (ok) {
          await deletePreviousAutoSave();
          const fileHandle = await workingDirHandle.getFileHandle(newFileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(buf);
          await writable.close();
          savedLocations.push(workingDirHandle.name);
        }
      } catch (e) {
        console.warn("Local save failed", e);
        failedLocations.push("本地");
      }
    } else if (state.fileName && typeof state.fileHandle !== 'undefined' && state.fileHandle) {
      // Use the folder from the opened file as default
      try {
        const parentDir = await state.fileHandle.getFile();
        // Note: Can't get parent directory from file handle, skip
      } catch (e) {
        // Ignore
      }
    }

    // 2. Save to cloud (if configured) - always save if token exists
    if (cloudStorage.googleToken) {
      try {
        // Delete previous cloud file
        if (currentAutoSaveFileName) {
          await googleDriveDeleteFile(currentAutoSaveFileName);
        }
        const success = await googleDriveUpload(newFileName, buf);
        if (success) savedLocations.push("Google Drive");
        else failedLocations.push("Google Drive");
      } catch (e) {
        console.warn("Google Drive save failed", e);
        failedLocations.push("Google Drive");
      }
    }

    if (cloudStorage.onedriveToken) {
      try {
        // Delete previous cloud file
        if (currentAutoSaveFileName) {
          await onedriveDeleteFile(currentAutoSaveFileName);
        }
        const success = await onedriveUpload(newFileName, buf);
        if (success) savedLocations.push("OneDrive");
        else failedLocations.push("OneDrive");
      } catch (e) {
        console.warn("OneDrive save failed", e);
        failedLocations.push("OneDrive");
      }
    }

    // Update state if any save succeeded
    if (savedLocations.length > 0) {
      currentAutoSaveFileName = newFileName;
      await idbPut(LAST_SAVE_NAME_KEY, newFileName);
      state.dirty = false;
      lastAutoSaveTime = now.toLocaleString();
      saveToLocal();
      if (!silent) {
        let msg = `已保存到: ${savedLocations.join(", ")}`;
        if (failedLocations.length > 0) {
          msg += ` (失败: ${failedLocations.join(", ")})`;
        }
        toast(msg, "success");
      }
      updateWorkingFolderStatusUI();
    } else if (!silent && failedLocations.length > 0) {
      toast(`保存失败: ${failedLocations.join(", ")}`, "error");
    }
  }

  function startAutoSaveTimer() {
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    autoSaveTimer = setInterval(() => {
      runAutoSave(true);
    }, AUTO_SAVE_INTERVAL_MS);
  }

  function updateWorkingFolderStatusUI() {
    const el = $("backupStatus");
    if (!el) return;

    let html = "";

    // Main status - show what's configured
    html += `<div style="margin-bottom:10px;">`;

    // Local folder status
    html += `<div style="margin-bottom:6px;">
      <b>📁 本地文件夹：</b>
      ${workingDirHandle
        ? `<span class="bk-folder">${escapeHtml(workingDirHandle.name)}</span>`
        : '<span class="bk-warn">未设置</span>'}
    </div>`;

    // Cloud storage status
    html += `<div style="margin-bottom:6px;">
      <b>☁️ 网盘同步：</b>`;
    if (cloudStorage.googleToken) {
      html += `<span style="color:var(--success);">Google Drive 已连接</span>`;
    } else if (cloudStorage.onedriveToken) {
      html += `<span style="color:var(--success);">OneDrive 已连接</span>`;
    } else {
      html += `<span class="bk-warn">未连接</span>`;
    }
    html += `</div>`;

    // Auto-save info
    html += `<div style="font-size:11px;color:var(--ink-faint);margin-top:8px;padding:6px 8px;background:rgba(30,50,90,0.03);border-radius:4px;">
      <b style="color:var(--ink-dim);">自动保存说明：</b><br>
      • 每30分钟自动保存一次（有更新时）<br>
      • 本地文件夹：保存到 <b>客户总表_自动保存_时间戳.xlsx</b>，每次保存前删除旧文件<br>
      • 网盘：同步保存到已连接的云盘<br>
      • ${workingDirHandle ? '上次保存：' + (lastAutoSaveTime ? `<b>${escapeHtml(lastAutoSaveTime)}</b>` : '<span class="bk-warn">尚未保存</span>') : '请先选择本地文件夹'}
    </div>`;
    html += `</div>`;

    // Cloud storage selector for connecting/disconnecting
    html += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
      <label style="font-weight:700;color:var(--ink);font-size:12px;">连接网盘账号：</label>
      <select id="cloudProviderSelect" style="height:28px;padding:0 8px;border:1px solid var(--border);border-radius:6px;background:#fff;color:var(--ink);font-size:11px;margin-left:6px;">
        <option value="none" ${!cloudStorage.googleToken && !cloudStorage.onedriveToken ? "selected" : ""}>不连接</option>
        <option value="google" ${cloudStorage.googleToken ? "selected" : ""}>Google Drive</option>
        <option value="onedrive" ${cloudStorage.onedriveToken ? "selected" : ""}>OneDrive</option>
      </select>
    </div>`;

    el.innerHTML = html;

    // Show/hide config sections based on provider
    const googleSection = $("googleDriveConfigSection");
    const onedriveSection = $("oneDriveConfigSection");
    if (googleSection) googleSection.style.display = (cloudStorage.provider === "google" && !cloudStorage.googleToken) ? "block" : "none";
    if (onedriveSection) onedriveSection.style.display = (cloudStorage.provider === "onedrive" && !cloudStorage.onedriveToken) ? "block" : "none";

    // Bind cloud provider selector
    const providerSelect = $("cloudProviderSelect");
    if (providerSelect) {
      providerSelect.addEventListener("change", async () => {
        const val = providerSelect.value;
        if (val === "none") {
          // Disconnect cloud
          if (cloudStorage.googleToken) {
            cloudStorage.googleToken = null;
            await idbDel(GOOGLE_DRIVE_TOKEN_KEY);
          }
          if (cloudStorage.onedriveToken) {
            cloudStorage.onedriveToken = null;
            await idbDel(ONEDRIVE_TOKEN_KEY);
            if (msalInstance) msalInstance.logoutPopup();
          }
          cloudStorage.provider = "local";
          toast("已断开网盘连接", "success");
        } else {
          cloudStorage.provider = val;
        }
        await saveCloudStorageState();
        updateWorkingFolderStatusUI();
        updateCloudButtons();
      });
    }

    // Bind config save buttons
    const saveGoogleBtn = $("saveGoogleConfig");
    const saveOnedriveBtn = $("saveOnedriveConfig");
    if (saveGoogleBtn) {
      saveGoogleBtn.addEventListener("click", async () => {
        googleDriveConfig.clientId = $("googleClientId").value.trim();
        googleDriveConfig.apiKey = $("googleApiKey").value.trim();
        await idbPut(GOOGLE_CONFIG_KEY, googleDriveConfig);
        toast("Google Drive 配置已保存", "success");
        updateWorkingFolderStatusUI();
        updateCloudButtons();
      });
    }
    if (saveOnedriveBtn) {
      saveOnedriveBtn.addEventListener("click", async () => {
        onedriveConfig.clientId = $("onedriveClientId").value.trim();
        await idbPut(ONEDRIVE_CONFIG_KEY, onedriveConfig);
        toast("OneDrive 配置已保存", "success");
        updateWorkingFolderStatusUI();
        updateCloudButtons();
      });
    }

    // Populate config inputs with saved values
    const googleClientIdInput = $("googleClientId");
    const googleApiKeyInput = $("googleApiKey");
    const onedriveClientIdInput = $("onedriveClientId");
    if (googleClientIdInput) googleClientIdInput.value = googleDriveConfig.clientId || "";
    if (googleApiKeyInput) googleApiKeyInput.value = googleDriveConfig.apiKey || "";
    if (onedriveClientIdInput) onedriveClientIdInput.value = onedriveConfig.clientId || "";
  }

  function updateCloudButtons() {
    const actionsEl = $("backupActions");
    if (!actionsEl) return;

    let buttonsHtml = "";

    // Always show local folder selector
    buttonsHtml += `<button class="sbtn small" id="btnPickBackup">${workingDirHandle ? '更换' : '选择'}工作文件夹</button>`;

    // Show cloud login buttons if not connected
    if (!cloudStorage.googleToken && !cloudStorage.onedriveToken) {
      if (isGoogleDriveConfigured()) {
        buttonsHtml += `<button class="sbtn small" id="btnGoogleLogin">登录 Google Drive</button>`;
      }
      if (isOneDriveConfigured()) {
        buttonsHtml += `<button class="sbtn small" id="btnOneDriveLogin">登录 OneDrive</button>`;
      }
    }

    // Always show save now button
    buttonsHtml += `<button class="sbtn small success" id="btnBackupNow">立即保存</button>`;

    // Show stop button if auto-save is active
    if (workingDirHandle || cloudStorage.googleToken || cloudStorage.onedriveToken) {
      buttonsHtml += `<button class="sbtn small ghost" id="btnClearBackup">停止自动保存</button>`;
    }

    actionsEl.innerHTML = buttonsHtml;

    // Bind button events
    const btnPick = $("btnPickBackup");
    const btnNow = $("btnBackupNow");
    const btnClear = $("btnClearBackup");
    const btnGoogleLogin = $("btnGoogleLogin");
    const btnOneDriveLogin = $("btnOneDriveLogin");

    if (btnPick) btnPick.onclick = () => pickWorkingFolder();
    if (btnNow) btnNow.onclick = () => runAutoSave(false);
    if (btnClear) btnClear.onclick = () => clearCloudStorage();
    if (btnGoogleLogin) btnGoogleLogin.onclick = async () => {
      const success = await authenticateGoogleDrive();
      if (success) {
        toast("Google Drive 已连接，将同时保存到本地和云端", "success");
        updateWorkingFolderStatusUI();
        updateCloudButtons();
      }
    };
    if (btnOneDriveLogin) btnOneDriveLogin.onclick = async () => {
      const success = await authenticateOneDrive();
      if (success) {
        toast("OneDrive 已连接，将同时保存到本地和云端", "success");
        updateWorkingFolderStatusUI();
        updateCloudButtons();
      }
    };
  }

  async function clearCloudStorage() {
    if (cloudStorage.provider === "local") {
      workingDirHandle = null;
      await idbDel(WORKING_DIR_HANDLE_KEY);
      currentAutoSaveFileName = "";
      await idbDel(LAST_SAVE_NAME_KEY);
      toast("已取消自动保存", "success");
    } else if (cloudStorage.provider === "google") {
      cloudStorage.googleToken = null;
      await idbDel(GOOGLE_DRIVE_TOKEN_KEY);
      toast("已退出 Google Drive", "success");
    } else if (cloudStorage.provider === "onedrive") {
      cloudStorage.onedriveToken = null;
      await idbDel(ONEDRIVE_TOKEN_KEY);
      if (msalInstance) {
        msalInstance.logoutPopup();
      }
      toast("已退出 OneDrive", "success");
    }
    currentAutoSaveFileName = "";
    updateWorkingFolderStatusUI();
    updateCloudButtons();
  }
  /* ============================================================
     INIT & EVENT WIRING
     ============================================================ */
  async function init() {
    // V4: open IndexedDB first
    try { await idbOpen(); } catch (e) { console.warn("IDB open failed", e); }

    // Check if returning from OAuth redirect
    if (window.location.hash.includes("access_token")) {
      try {
        await loadCloudStorageState();
        const success = await authenticateGoogleDrive();
        if (success) {
          // Reload to clean state
          window.location.reload();
          return;
        }
      } catch (e) {
        console.warn("OAuth redirect handling failed:", e);
      }
    }

    // Bind all button events
    try {
      // Open file with dropdown
      $("btnOpen").addEventListener("click", (e) => {
        e.stopPropagation();

        // Remove existing menu if any
        const existingMenu = document.querySelector(".open-dropdown-menu");
        if (existingMenu) { existingMenu.remove(); return; }

        // Create dropdown menu
        const menu = document.createElement("div");
        menu.className = "open-dropdown-menu";
        menu.style.cssText = `
          position: absolute; top: 100%; left: 0; z-index: 1000;
          background: #fff; border: 1px solid var(--border); border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.15); min-width: 200px;
          padding: 6px 0; margin-top: 4px;
        `;

        // Local file option
        const localOption = document.createElement("div");
        localOption.className = "dropdown-item";
        localOption.style.cssText = "padding: 8px 16px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 8px;";
        localOption.innerHTML = `<span>📁</span><span>打开本地文件</span>`;
        localOption.onclick = (ev) => { ev.stopPropagation(); menu.remove(); $("fileInput").click(); };
        menu.appendChild(localOption);

        // Google Drive option
        if (cloudStorage.googleToken) {
          const googleOption = document.createElement("div");
          googleOption.className = "dropdown-item";
          googleOption.style.cssText = "padding: 8px 16px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 8px;";
          googleOption.innerHTML = `<span>☁️</span><span>从 Google Drive 打开</span>`;
          googleOption.onclick = (ev) => { ev.stopPropagation(); menu.remove(); openGoogleDriveFile(); };
          menu.appendChild(googleOption);
        }

        // OneDrive option
        if (cloudStorage.onedriveToken) {
          const onedriveOption = document.createElement("div");
          onedriveOption.className = "dropdown-item";
          onedriveOption.style.cssText = "padding: 8px 16px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 8px;";
          onedriveOption.innerHTML = `<span>🔷</span><span>从 OneDrive 打开</span>`;
          onedriveOption.onclick = (ev) => { ev.stopPropagation(); menu.remove(); openOneDriveFile(); };
          menu.appendChild(onedriveOption);
        }

        // Position the button relative and append menu
        $("btnOpen").style.position = "relative";
        $("btnOpen").appendChild(menu);

        // Close menu when clicking outside (use mousedown to avoid conflicts)
        const closeMenu = (evt) => {
          if (!menu.contains(evt.target) && evt.target !== $("btnOpen") && !$("btnOpen").contains(evt.target)) {
            menu.remove();
            document.removeEventListener("mousedown", closeMenu);
          }
        };
        setTimeout(() => document.addEventListener("mousedown", closeMenu), 0);
      });

      $("fileInput").addEventListener("change", (e) => {
        if (e.target.files[0]) importExcel(e.target.files[0]);
        e.target.value = "";
      });
      $("btnSave").addEventListener("click", exportExcel);
      $("btnImport").addEventListener("click", batchImport);
      $("btnNew").addEventListener("click", newCustomer);
      $("btnBatchUpdate").addEventListener("click", batchUpdate);
      $("btnExportConvert").addEventListener("click", exportToConvertList);
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
    } catch (e) {
      console.error("Event binding failed:", e);
    }

    // Load data and restore state
    try {
      if (await loadFromLocal()) {
        renderAll();
        toast(`已从本地恢复 ${state.customers.length} 条客户数据`, "success");
      } else {
        populateFilterDropdowns();
        updateStats();
      }
    } catch (e) {
      console.warn("Load from local failed:", e);
      populateFilterDropdowns();
      updateStats();
    }

    // V4: restore working folder handle + start 30-min timer
    try {
      await restoreWorkingFolderHandle();
      await loadCloudStorageState();
      startAutoSaveTimer();
    } catch (e) {
      console.warn("Cloud storage restore failed:", e);
    }

    window.addEventListener("beforeunload", () => {
      if (state.dirty) {
        saveToLocal();
        // best-effort auto-save on unload
        runAutoSave(true);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
