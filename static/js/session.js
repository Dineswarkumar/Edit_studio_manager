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
})();
