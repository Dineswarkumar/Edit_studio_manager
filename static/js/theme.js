// Modern Multi-Theme Controller (Midnight Dark · Obsidian OLED · Nordic Slate · Daylight Light)
(function() {
  const THEMES = [
    { id: 'dark',  label: 'Midnight', icon: '◐', meta: '#0b1628' },
    { id: 'oled',  label: 'Obsidian', icon: '●', meta: '#07080a' },
    { id: 'nord',  label: 'Nordic',   icon: '◈', meta: '#1c232d' },
    { id: 'light', label: 'Daylight', icon: '☼', meta: '#f1f6fd' }
  ];
  const VALID_IDS = new Set(THEMES.map(t => t.id));

  function getPreferredTheme() {
    try {
      const saved = localStorage.getItem('theme');
      if (saved && VALID_IDS.has(saved)) return saved;
    } catch (e) {}
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }

  function getThemeMeta(id) {
    return THEMES.find(t => t.id === id) || THEMES[0];
  }

  function applyTheme(themeId) {
    const chosen = VALID_IDS.has(themeId) ? themeId : 'dark';
    const meta = getThemeMeta(chosen);
    if (chosen === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', chosen);
    }
    const themeColorEl = document.querySelector('meta[name="theme-color"]');
    if (themeColorEl) themeColorEl.setAttribute('content', meta.meta);
    try {
      localStorage.setItem('theme', chosen);
    } catch (e) {}
    updateToggleButtons(chosen);
  }

  function getActiveTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    return (attr && VALID_IDS.has(attr)) ? attr : 'dark';
  }

  function getNextTheme(currentId) {
    const idx = THEMES.findIndex(t => t.id === currentId);
    return THEMES[(idx + 1) % THEMES.length].id;
  }

  function updateToggleButtons(themeId) {
    const current = getThemeMeta(themeId);
    const next = getThemeMeta(getNextTheme(themeId));
    document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.textContent = current.icon;
      btn.dataset.activeTheme = current.id;
      btn.setAttribute('title', `Theme: ${current.label} — click for ${next.label} (Alt+T)`);
      btn.setAttribute('aria-label', `Theme ${current.label}. Switch to ${next.label}`);
    });
    const themeLabel = document.getElementById('activeThemeName');
    if (themeLabel) themeLabel.textContent = current.label;
  }

  // Apply immediately before body render to eliminate flash
  applyTheme(getPreferredTheme());

  document.addEventListener('DOMContentLoaded', () => {
    updateToggleButtons(getActiveTheme());
    document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        applyTheme(getNextTheme(getActiveTheme()));
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 't') {
        const tag = (e.target && e.target.tagName) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
        e.preventDefault();
        applyTheme(getNextTheme(getActiveTheme()));
      }
    });
  });

  window.setAppTheme = applyTheme;
  window.toggleAppTheme = function() {
    applyTheme(getNextTheme(getActiveTheme()));
  };
})();
