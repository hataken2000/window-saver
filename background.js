let lastNormalWindowId = null;

const SKIP_SCHEMES = ["chrome-extension://", "devtools://", "about:"];
const SKIP_URLS = ["chrome://settings", "chrome://extensions", "chrome://history", "chrome://downloads"];

// ウィンドウごとに独立したキーで保存（競合防止）
async function getSessionId(windowId) {
  const r = await chrome.storage.session.get(`ws_${windowId}`);
  return r[`ws_${windowId}`] || null;
}
async function setSessionId(windowId, sessionId) {
  await chrome.storage.session.set({ [`ws_${windowId}`]: sessionId });
}
async function clearSessionId(windowId) {
  await chrome.storage.session.remove(`ws_${windowId}`);
}
async function getWindowCache(windowId) {
  const r = await chrome.storage.session.get(`wc_${windowId}`);
  return r[`wc_${windowId}`] || null;
}
async function setWindowCache(windowId, data) {
  await chrome.storage.session.set({ [`wc_${windowId}`]: data });
}
async function clearWindowCache(windowId) {
  await chrome.storage.session.remove(`wc_${windowId}`);
}

// --- キャッシュ更新 ---

async function updateWindowCache(windowId) {
  try {
    const win = await chrome.windows.get(windowId, { populate: true });
    if (win.type !== "normal") return;

    let groups = {};
    try {
      const tabGroups = await chrome.tabGroups.query({ windowId });
      tabGroups.forEach(g => {
        groups[g.id] = { title: g.title, color: g.color, collapsed: g.collapsed };
      });
    } catch (_) {}

    const tabs = win.tabs
      .filter(t => !SKIP_SCHEMES.some(s => t.url.startsWith(s)) && !SKIP_URLS.some(u => t.url.startsWith(u)))
      .map(t => ({
        url: t.url,
        title: t.title,
        pinned: t.pinned,
        groupId: t.groupId >= 0 ? t.groupId : null,
      }));

    await setWindowCache(windowId, { tabs, groups });
  } catch (_) {}
}

chrome.tabs.onCreated.addListener(tab => updateWindowCache(tab.windowId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.pinned || changeInfo.status === "complete") {
    updateWindowCache(tab.windowId);
  }
});
chrome.tabs.onMoved.addListener((tabId, { windowId }) => updateWindowCache(windowId));
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => updateWindowCache(newWindowId));
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => updateWindowCache(oldWindowId));
try {
  chrome.tabGroups.onUpdated.addListener(group => updateWindowCache(group.windowId));
  chrome.tabGroups.onRemoved.addListener(group => updateWindowCache(group.windowId));
} catch (_) {}

// ウィンドウが閉じるとき → キャッシュで上書き保存
chrome.tabs.onRemoved.addListener(async (tabId, { windowId, isWindowClosing }) => {
  if (!isWindowClosing) {
    updateWindowCache(windowId);
    return;
  }

  const sessionId = await getSessionId(windowId);
  if (!sessionId) return;

  await clearSessionId(windowId);
  const snapshot = await getWindowCache(windowId);
  await clearWindowCache(windowId);

  if (snapshot) await overwriteSession(sessionId, snapshot);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const win = await chrome.windows.get(windowId);
    if (win.type === "normal") lastNormalWindowId = windowId;
  } catch (_) {}
});

// --- メッセージ ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SAVE_SESSION") {
    saveSession(message.name).then(sendResponse);
    return true;
  }
  if (message.type === "RESTORE_SESSION") {
    restoreSession(message.session).then(sendResponse);
    return true;
  }
  if (message.type === "DELETE_SESSION") {
    deleteSession(message.id).then(sendResponse);
    return true;
  }
  if (message.type === "GET_SESSIONS") {
    getSessions().then(sendResponse);
    return true;
  }
  if (message.type === "RENAME_SESSION") {
    renameSession(message.id, message.name).then(sendResponse);
    return true;
  }
});

// --- セッション操作 ---

async function getTargetWindow() {
  if (lastNormalWindowId) {
    try {
      return await chrome.windows.get(lastNormalWindowId, { populate: true });
    } catch (_) {}
  }
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return windows.find(w => w.focused) || windows[0];
}

async function saveSession(name) {
  const win = await getTargetWindow();
  if (!win) return { ok: false };

  let groups = {};
  try {
    const tabGroups = await chrome.tabGroups.query({ windowId: win.id });
    tabGroups.forEach(g => {
      groups[g.id] = { title: g.title, color: g.color, collapsed: g.collapsed };
    });
  } catch (_) {}

  const tabs = win.tabs
    .filter(t => !SKIP_SCHEMES.some(s => t.url.startsWith(s)))
    .map(t => ({
      url: t.url,
      title: t.title,
      pinned: t.pinned,
      groupId: t.groupId >= 0 ? t.groupId : null,
    }));

  const session = {
    id: Date.now().toString(),
    name: name || new Date().toLocaleString("ja-JP"),
    savedAt: Date.now(),
    tabs,
    groups,
  };

  const { sessions = [] } = await chrome.storage.local.get("sessions");
  sessions.unshift(session);
  await chrome.storage.local.set({ sessions });

  await setSessionId(win.id, session.id);
  await setWindowCache(win.id, { tabs, groups });

  return { ok: true, session };
}

async function overwriteSession(sessionId, { tabs, groups }) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;

  session.tabs = tabs;
  session.groups = groups;
  session.savedAt = Date.now();

  await chrome.storage.local.set({ sessions });
}

async function restoreSession(session) {
  const newWindow = await chrome.windows.create({});
  const newWindowId = newWindow.id;
  const groupIdMap = {};

  for (const tab of session.tabs) {
    let created;
    try {
      created = await chrome.tabs.create({
        windowId: newWindowId,
        url: tab.url === "chrome://newtab/" ? undefined : tab.url,
        pinned: tab.pinned,
      });
    } catch (_) {
      continue;
    }

    if (tab.groupId !== null) {
      const oldGroupId = tab.groupId;
      if (!groupIdMap[oldGroupId]) {
        const group = session.groups[oldGroupId];
        const newGroupId = await chrome.tabs.group({
          tabIds: [created.id],
          createProperties: { windowId: newWindowId },
        });
        if (group) {
          await chrome.tabGroups.update(newGroupId, {
            title: group.title || "",
            color: group.color || "grey",
            collapsed: group.collapsed || false,
          });
        }
        groupIdMap[oldGroupId] = newGroupId;
      } else {
        await chrome.tabs.group({
          tabIds: [created.id],
          groupId: groupIdMap[oldGroupId],
        });
      }
    }
  }

  const allTabs = await chrome.tabs.query({ windowId: newWindowId });
  const emptyTab = allTabs.find(t => t.url === "chrome://newtab/" && t.index === 0);
  if (emptyTab && allTabs.length > 1) {
    await chrome.tabs.remove(emptyTab.id);
  }

  await setSessionId(newWindowId, session.id);

  return { ok: true };
}

async function deleteSession(id) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const updated = sessions.filter(s => s.id !== id);
  await chrome.storage.local.set({ sessions: updated });
  return { ok: true };
}

async function renameSession(id, name) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const session = sessions.find(s => s.id === id);
  if (session) session.name = name;
  await chrome.storage.local.set({ sessions });
  return { ok: true };
}

async function getSessions() {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  return sessions;
}
