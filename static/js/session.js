// Tab-Isolated Session Manager with Auto-Cleanup on Tab Close
(function() {
  let tabSessionId = sessionStorage.getItem('studio_tab_session_id');
  if (!tabSessionId) {
    tabSessionId = 'tab_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
    sessionStorage.setItem('studio_tab_session_id', tabSessionId);
  }
  window.STUDIO_TAB_SESSION_ID = tabSessionId;

  // Cleanup files for this tab session when the tab closes or navigates away
  let cleanupSent = false;
  function handleTabClose() {
    if (cleanupSent || !window.STUDIO_TAB_SESSION_ID) return;
    cleanupSent = true;
    try {
      const payload = JSON.stringify({ session_id: window.STUDIO_TAB_SESSION_ID });
      const blob = new Blob([payload], { type: 'application/json' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/session/cleanup', blob);
      } else {
        fetch('/api/session/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true
        });
      }
    } catch (e) {
      console.warn('Cleanup error on tab close:', e);
    }
  }

  window.addEventListener('pagehide', handleTabClose);
  window.addEventListener('beforeunload', handleTabClose);

  // Automatic --lan 6-digit pairing PIN prompt when browsing from a mobile LAN client
  async function checkLanPinAuth() {
    if (window.FRAME_STUDIO_OFFLINE) return;
    try {
      const res = await fetch('/api/auth/lan-status', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.lan_protected || data.authenticated) return;
      showLanPinModal();
    } catch (_) {}
  }

  function showLanPinModal() {
    if (document.getElementById('fsLanPinModal')) return;
    const modal = document.createElement('div');
    modal.id = 'fsLanPinModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(10,12,18,0.86);display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML = `
      <div style="background:#161b26;border:1px solid #2b3446;border-radius:12px;padding:22px;max-width:360px;width:100%;color:#e2e8f0;font-family:system-ui,sans-serif;">
        <h3 style="margin:0 0 8px;font-size:17px;">LAN Pairing Required</h3>
        <p style="margin:0 0 14px;font-size:13px;color:#94a3b8;">Enter the 6-digit PIN printed in your PC Frame Studio terminal.</p>
        <input id="fsLanPinInput" type="tel" maxlength="8" placeholder="6-digit PIN" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0f131c;color:#fff;font-size:18px;letter-spacing:4px;text-align:center;">
        <div id="fsLanPinErr" style="color:#fb7185;font-size:12px;min-height:18px;margin-top:8px;"></div>
        <button id="fsLanPinSubmit" style="width:100%;margin-top:6px;padding:10px;border-radius:8px;border:none;background:#38bdf8;color:#082f49;font-weight:700;cursor:pointer;">Connect to PC Studio</button>
      </div>
    `;
    document.body.appendChild(modal);
    const input = document.getElementById('fsLanPinInput');
    const errEl = document.getElementById('fsLanPinErr');
    const btn = document.getElementById('fsLanPinSubmit');

    async function verify() {
      const pin = (input.value || '').trim();
      if (!pin) return;
      errEl.textContent = '';
      btn.disabled = true;
      try {
        const res = await fetch('/api/auth/lan-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ pin })
        });
        const data = await res.json();
        if (!res.ok || !data.authenticated) {
          errEl.textContent = data.detail || 'Incorrect PIN';
          btn.disabled = false;
          return;
        }
        modal.remove();
        window.location.reload();
      } catch (err) {
        errEl.textContent = 'Connection failed';
        btn.disabled = false;
      }
    }

    btn.addEventListener('click', verify);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
    input.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkLanPinAuth);
  } else {
    checkLanPinAuth();
  }
})();
