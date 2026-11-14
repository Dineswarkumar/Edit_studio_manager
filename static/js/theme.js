// Dark & Light Mode Theme Controller
(function() {
  function getPreferredTheme() {
    const saved = localStorage.getItem('theme');
    if (saved) return saved;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem('theme', theme);
    } catch (e) {}
    updateToggleButtons(theme);
  }

  function updateToggleButtons(theme) {
    document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.textContent = theme === 'light' ? '☾' : '☼';
      btn.setAttribute('title', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
      btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    });
  }

  // Apply immediately before body render to eliminate flash
  const initialTheme = getPreferredTheme();
  applyTheme(initialTheme);

  document.addEventListener('DOMContentLoaded', () => {
    updateToggleButtons(getPreferredTheme());
    document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const activeTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        const newTheme = activeTheme === 'light' ? 'dark' : 'light';
        applyTheme(newTheme);
      });
    });
  });

  window.toggleAppTheme = function() {
    const activeTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    applyTheme(activeTheme === 'light' ? 'dark' : 'light');
  };
})();
