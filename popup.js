const saveBtn = document.getElementById("saveBtn");
const sessionNameInput = document.getElementById("sessionName");
const sessionList = document.getElementById("sessionList");

function defaultName() {
  return new Date().toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

saveBtn.addEventListener("click", async () => {
  const name = sessionNameInput.value.trim() || defaultName();
  saveBtn.disabled = true;
  saveBtn.textContent = "保存中...";

  await chrome.runtime.sendMessage({ type: "SAVE_SESSION", name });

  sessionNameInput.value = "";
  saveBtn.disabled = false;
  saveBtn.textContent = "保存";
  await renderSessions();
});

async function renderSessions() {
  const sessions = await chrome.runtime.sendMessage({ type: "GET_SESSIONS" });

  if (!sessions || sessions.length === 0) {
    sessionList.innerHTML = '<p class="empty">保存済みセッションなし</p>';
    return;
  }

  sessionList.innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";

    const tabCount = session.tabs.length;
    const groupCount = Object.keys(session.groups || {}).length;
    const date = new Date(session.savedAt).toLocaleString("ja-JP", {
      month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

    item.innerHTML = `
      <div class="session-info">
        <div class="session-name" data-id="${session.id}" title="クリックで編集">${escHtml(session.name)}</div>
        <div class="session-meta">${tabCount}タブ${groupCount > 0 ? ` · ${groupCount}グループ` : ""} · ${date}</div>
      </div>
      <div class="session-actions">
        <button class="btn-restore" data-id="${session.id}">復元</button>
        <button class="btn-delete" data-id="${session.id}" title="削除">✕</button>
      </div>
    `;

    item.querySelector(".session-name").addEventListener("click", (e) => {
      startRename(e.target, session);
    });

    item.querySelector(".btn-restore").addEventListener("click", async (e) => {
      const id = e.target.dataset.id;
      const target = sessions.find(s => s.id === id);
      if (target) {
        e.target.disabled = true;
        e.target.textContent = "開中...";
        await chrome.runtime.sendMessage({ type: "RESTORE_SESSION", session: target });
        window.close();
      }
    });

    item.querySelector(".btn-delete").addEventListener("click", async (e) => {
      const id = e.target.dataset.id;
      await chrome.runtime.sendMessage({ type: "DELETE_SESSION", id });
      await renderSessions();
    });

    sessionList.appendChild(item);
  }
}

function startRename(el, session) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = session.name;
  input.className = "rename-input";
  el.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim() || session.name;
    await chrome.runtime.sendMessage({ type: "RENAME_SESSION", id: session.id, name: newName });
    await renderSessions();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.removeEventListener("blur", commit);
      renderSessions();
    }
  });
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

renderSessions();
