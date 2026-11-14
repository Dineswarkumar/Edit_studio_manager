// Shared editor workspace layout, resizing and collapsible settings.
(function () {
  function initWorkspace(workspace) {
    const media = workspace.querySelector('.media-panel');
    const preview = workspace.querySelector('#previewPanel');
    const tools = workspace.querySelector('.tools-panel');
    if (!media || !preview || !tools) return;

    if (!workspace.querySelector('.media-resizer')) {
      const divider = document.createElement('div');
      divider.className = 'workspace-resizer media-resizer';
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-orientation', 'vertical');
      divider.tabIndex = 0;
      divider.setAttribute('aria-label', 'Resize media panel');
      workspace.insertBefore(divider, preview);
    }
    if (!workspace.querySelector('.tools-resizer')) {
      const divider = document.createElement('div');
      divider.className = 'workspace-resizer tools-resizer';
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-orientation', 'vertical');
      divider.tabIndex = 0;
      divider.setAttribute('aria-label', 'Resize settings panel');
      workspace.insertBefore(divider, tools);
    }

    const storageKey = `workspace-layout-${workspace.id || location.pathname}`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(`${storageKey}-size`) || '{}'); } catch (_) {}
    if (saved.mediaWidth) workspace.style.setProperty('--media-width', `${saved.mediaWidth}px`);
    if (saved.toolsWidth) workspace.style.setProperty('--tools-width', `${saved.toolsWidth}px`);

    const setLayout = layout => {
      workspace.dataset.layout = layout;
      document.querySelectorAll('.layout-choice').forEach(button => {
        button.classList.toggle('active', button.dataset.layout === layout);
        button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
      });
      localStorage.setItem(storageKey, layout);
    };
    document.querySelectorAll('.layout-choice').forEach(button => {
      button.addEventListener('click', () => setLayout(button.dataset.layout));
    });
    setLayout(localStorage.getItem(storageKey) || workspace.dataset.layout || 'standard');

    const updateLayoutLabels = () => {
      const compact = window.matchMedia('(max-width: 1000px)').matches;
      document.querySelectorAll('.layout-choice').forEach(button => {
        const labels = compact
          ? { standard: 'Media first', reversed: 'Media last', focus: 'Preview first' }
          : { standard: 'Media left', reversed: 'Media right', focus: 'Wide preview' };
        const descriptions = compact
          ? { standard: 'Photos, preview, then design', reversed: 'Design, preview, then photos', focus: 'Preview, photos, then design' }
          : { standard: 'Photos left, preview center, design right', reversed: 'Design left, preview center, photos right', focus: 'Wider preview with narrower side panels' };
        button.textContent = labels[button.dataset.layout] || button.textContent;
        button.title = descriptions[button.dataset.layout] || button.title;
        button.setAttribute('aria-label', `${labels[button.dataset.layout] || button.textContent}: ${descriptions[button.dataset.layout] || ''}`);
      });
    };
    updateLayoutLabels();
    window.addEventListener('resize', updateLayoutLabels, { passive: true });

    [media, tools].forEach(panel => {
      const button = panel.querySelector('.panel-collapse');
      if (!button) return;
      const side = panel === media ? 'media' : 'tools';
      const collapsedKey = `${storageKey}-${side}-collapsed`;
      const setCollapsed = collapsed => {
        panel.classList.toggle('is-collapsed', collapsed);
        button.textContent = collapsed ? '+' : '−';
        button.title = collapsed ? 'Expand panel' : 'Collapse panel';
        button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${side === 'media' ? 'media' : 'settings'} panel`);
        button.setAttribute('aria-expanded', String(!collapsed));
        localStorage.setItem(collapsedKey, collapsed ? 'true' : 'false');
      };
      setCollapsed(localStorage.getItem(collapsedKey) === 'true');
      button.addEventListener('click', () => {
        setCollapsed(!panel.classList.contains('is-collapsed'));
      });
    });

    const computeSectionSummary = body => {
      const activeBtn = body.querySelector('.segment-btn.active, .template-choice.active, .matrix-btn.active, .preset-card.active .preset-title, .emoji-btn.active');
      if (activeBtn) {
        const text = activeBtn.textContent.replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 26);
      }
      const select = body.querySelector('select');
      if (select && select.selectedOptions && select.selectedOptions[0]) {
        return select.selectedOptions[0].textContent.split('·')[0].trim().slice(0, 26);
      }
      const textInput = body.querySelector('input[type="text"]');
      if (textInput && textInput.value.trim()) {
        return textInput.value.trim().slice(0, 22);
      }
      return '';
    };

    const sections = [];
    const syncToggleAllButton = () => {
      if (!toggleAllBtn || sections.length === 0) return;
      const visibleSections = sections.filter(s => getComputedStyle(s).display !== 'none');
      const targetList = visibleSections.length ? visibleSections : sections;
      const collapsedCount = targetList.filter(s => s.classList.contains('section-collapsed')).length;
      const mostlyCollapsed = collapsedCount > targetList.length / 2;
      toggleAllBtn.textContent = mostlyCollapsed ? '+ All' : '− All';
      toggleAllBtn.title = mostlyCollapsed ? 'Expand all sections' : 'Collapse all sections';
      toggleAllBtn.setAttribute('aria-pressed', String(!mostlyCollapsed));
    };

    const toolsHeader = tools.querySelector(':scope > .panel-header');
    const toolsCollapseBtn = toolsHeader ? toolsHeader.querySelector('.panel-collapse') : null;
    let toggleAllBtn = null;
    if (toolsHeader && !toolsHeader.querySelector('.sections-toggle-all')) {
      toggleAllBtn = document.createElement('button');
      toggleAllBtn.type = 'button';
      toggleAllBtn.className = 'sections-toggle-all';
      toggleAllBtn.textContent = '− All';
      toggleAllBtn.title = 'Collapse all sections';
      if (toolsCollapseBtn) toolsHeader.insertBefore(toggleAllBtn, toolsCollapseBtn);
      else toolsHeader.appendChild(toggleAllBtn);
    } else if (toolsHeader) {
      toggleAllBtn = toolsHeader.querySelector('.sections-toggle-all');
    }

    tools.querySelectorAll('.panel-content > .control-group, #layerEditorArea > .control-group').forEach((section, index) => {
      if (section.querySelector(':scope > .section-head')) return;
      section.classList.add('studio-section');

      // 1. Locate source heading / label
      let headingRow = null;
      let label = section.querySelector(':scope > .control-label, :scope > label.control-label, :scope > div.control-label, :scope > span.control-label');
      if (!label) {
        const firstChild = section.firstElementChild;
        if (firstChild && firstChild.tagName === 'DIV' && (firstChild.querySelector(':scope > .control-label, :scope > label') || firstChild.classList.contains('control-label'))) {
          headingRow = firstChild;
          label = firstChild.querySelector(':scope > .control-label, :scope > label') || firstChild;
        } else if (firstChild && firstChild.tagName === 'SPAN') {
          label = firstChild;
        } else if (firstChild && firstChild.tagName === 'LABEL' && !firstChild.querySelector('input, select, textarea')) {
          label = firstChild;
        }
      }

      let fallbackTitle = null;
      if (section.id === 'tiledLayoutControls') fallbackTitle = 'Tiled Pattern Spacing';
      else if (section.id === 'singleLayoutControls') fallbackTitle = '9-Grid Anchor Position';

      // 2. Collect inline action buttons or live readout badges (to keep outside <button>)
      const asideItems = [];
      const searchRoot = headingRow || label;
      if (searchRoot) {
        searchRoot.querySelectorAll('button, .val-indicator, span[id$="Val"], span[id$="Text"]').forEach(node => {
          if (node !== label && node.id !== 'labelIntensity') {
            asideItems.push(node);
          }
        });
      }

      // 3. Extract clean single title string
      const titleCopy = label ? label.cloneNode(true) : null;
      if (titleCopy) {
        titleCopy.querySelectorAll('button, input, select, .val-indicator, span[id$="Val"], span[id$="Text"], .badge').forEach(node => node.remove());
      }
      let title = titleCopy ? titleCopy.textContent.trim().replace(/\s+/g, ' ') : '';
      if (!title && fallbackTitle) title = fallbackTitle;
      if (!title) title = `Settings ${index + 1}`;

      const labelId = (label && label.id) ? label.id : null;

      // 4. Remove source heading from body and remove any matching duplicate heading labels inside
      if (headingRow) headingRow.remove();
      else if (label) label.remove();

      const normTitle = title.toLowerCase();
      Array.from(section.children).forEach(child => {
        if ((child.classList.contains('control-label') || child.tagName === 'LABEL') && !child.querySelector('input, select, textarea')) {
          if (child.textContent.trim().replace(/\s+/g, ' ').toLowerCase() === normTitle) {
            child.remove();
          }
        }
      });

      // 5. Build section-head: clickable toggle button + optional sibling aside (never nesting buttons)
      const head = document.createElement('div');
      head.className = 'section-head';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'section-toggle';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'section-title';
      if (labelId) titleSpan.id = labelId;
      titleSpan.textContent = title;

      const summarySpan = document.createElement('span');
      summarySpan.className = 'section-summary';

      const pill = document.createElement('span');
      pill.className = 'section-toggle-pill';
      pill.setAttribute('aria-hidden', 'true');

      toggle.append(titleSpan, summarySpan, pill);
      head.appendChild(toggle);

      if (asideItems.length > 0) {
        const aside = document.createElement('div');
        aside.className = 'section-aside';
        asideItems.forEach(item => aside.appendChild(item));
        head.insertBefore(aside, toggle.nextSibling);
        // Move pill after aside so expand button is always the rightmost control
        head.appendChild(pill);
        pill.addEventListener('click', () => toggle.click());
        pill.style.cursor = 'pointer';
        pill.style.marginRight = '8px';
      }

      // 6. Wrap controls without any per-card scrollbar
      const wrapper = document.createElement('div');
      wrapper.className = 'section-collapse-wrapper';
      const body = document.createElement('div');
      body.className = 'section-body';
      while (section.firstChild) body.appendChild(section.firstChild);
      wrapper.appendChild(body);
      section.append(head, wrapper);

      const refreshSummary = () => {
        summarySpan.textContent = computeSectionSummary(body);
      };
      refreshSummary();
      body.addEventListener('input', refreshSummary);
      body.addEventListener('change', refreshSummary);
      body.addEventListener('click', () => queueMicrotask(refreshSummary));

      const key = `${storageKey}-section-${index}`;
      const applyState = collapsed => {
        section.classList.toggle('section-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        pill.textContent = collapsed ? '+' : '−';
        pill.title = collapsed ? `Expand ${title}` : `Collapse ${title}`;
        localStorage.setItem(key, collapsed ? 'closed' : 'open');
        refreshSummary();
      };

      applyState(localStorage.getItem(key) === 'closed');
      toggle.addEventListener('click', () => {
        applyState(!section.classList.contains('section-collapsed'));
        syncToggleAllButton();
      });

      section._setCollapsed = applyState;
      sections.push(section);
    });

    if (toggleAllBtn && !toggleAllBtn.dataset.bound) {
      toggleAllBtn.dataset.bound = 'true';
      toggleAllBtn.addEventListener('click', () => {
        const visibleSections = sections.filter(s => getComputedStyle(s).display !== 'none');
        const targetList = visibleSections.length ? visibleSections : sections;
        const collapsedCount = targetList.filter(s => s.classList.contains('section-collapsed')).length;
        const nextCollapsed = !(collapsedCount > targetList.length / 2);
        sections.forEach(sec => sec._setCollapsed && sec._setCollapsed(nextCollapsed));
        syncToggleAllButton();
      });
    }
    syncToggleAllButton();

    workspace.querySelectorAll('.workspace-resizer').forEach(handle => {
      const side = handle.classList.contains('media-resizer') ? 'media' : 'tools';
      const collapsed = () => (side === 'media' ? media : tools).classList.contains('is-collapsed');
      const getWidth = () => parseInt(getComputedStyle(workspace).getPropertyValue(`--${side}-width`), 10) || (side === 'media' ? 290 : 350);
      const getLimits = () => {
        const bounds = workspace.getBoundingClientRect();
        const style = getComputedStyle(workspace);
        const mediaWidth = parseInt(style.getPropertyValue('--media-width'), 10) || 290;
        const toolsWidth = parseInt(style.getPropertyValue('--tools-width'), 10) || 350;
        const minPreview = 280;
        const split = parseInt(style.getPropertyValue('--split-size'), 10) || 8;
        const available = bounds.width - split * 2 - minPreview;
        const otherWidth = side === 'media' ? toolsWidth : mediaWidth;
        const min = 190;
        const max = Math.max(min, Math.min(480, available - otherWidth));
        return { min, max };
      };
      const updateAria = () => {
        const limits = getLimits();
        handle.setAttribute('aria-valuemin', String(limits.min));
        handle.setAttribute('aria-valuemax', String(limits.max));
        handle.setAttribute('aria-valuenow', String(Math.round(getWidth())));
        handle.setAttribute('aria-valuetext', `${Math.round(getWidth())} pixels`);
      };
      updateAria();
      handle.addEventListener('keydown', event => {
        if (window.matchMedia('(max-width: 1000px)').matches || collapsed()) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const { min, max } = getLimits();
        const delta = event.shiftKey ? 40 : 12;
        let width = getWidth();
        if (event.key === 'Home') width = min;
        else if (event.key === 'End') width = max;
        else width += (event.key === 'ArrowRight' ? 1 : -1) * delta * (side === 'media' ? 1 : -1) * (workspace.dataset.layout === 'reversed' ? -1 : 1);
        workspace.style.setProperty(`--${side}-width`, `${Math.max(min, Math.min(max, width))}px`);
        updateAria();
        saveSizes();
      });
      const saveSizes = () => {
        const styles = getComputedStyle(workspace);
        localStorage.setItem(`${storageKey}-size`, JSON.stringify({
          mediaWidth: parseInt(styles.getPropertyValue('--media-width'), 10) || 290,
          toolsWidth: parseInt(styles.getPropertyValue('--tools-width'), 10) || 350
        }));
      };
      handle.addEventListener('pointerdown', event => {
        if (window.matchMedia('(max-width: 1000px)').matches || collapsed()) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('workspace-resizing');
        const bounds = workspace.getBoundingClientRect();
        const move = e => {
          const reversed = workspace.dataset.layout === 'reversed';
          const fromLeft = side === 'media' ? !reversed : reversed;
          const raw = fromLeft ? e.clientX - bounds.left : bounds.right - e.clientX;
          const { min, max } = getLimits();
          workspace.style.setProperty(`--${side}-width`, `${Math.max(min, Math.min(max, Math.round(raw)))}px`);
          updateAria();
        };
        const finish = () => {
          document.body.classList.remove('workspace-resizing');
          saveSizes();
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.editor-workspace').forEach(initWorkspace);
  });
})();
