let editorInstance = null;
const STORAGE_KEY = 'aeo-checker-docAreaHTML';

export async function initEditor({ el = '#docArea', placeholder = 'Paste or write your draft here…' } = {}) {
  const area = document.querySelector(el);
  if (!area) throw new Error(`Editor root not found: ${el}`);

  if (window.tinymce) {
    editorInstance = await window.tinymce.init({
      selector: el,
      inline: true,
      height: '100%',
      min_height: 400,
      menubar: false,
      toolbar: false,
      statusbar: false,
      skin: 'oxide-dark',
      plugins: [
        'advlist', 'autolink', 'lists', 'link', 'image', 'charmap', 'preview',
        'anchor', 'searchreplace', 'visualblocks', 'code', 'fullscreen',
        'insertdatetime', 'media', 'table', 'help', 'wordcount', 'autosave'
      ],
      autosave_restore_when_empty: true,
      autosave_interval: '10s',
      autosave_retention: '30d',
      content_style: `body { background-color: #2d2d2d; color: #ffffff; } a { color: #66b3ff !important; text-decoration: underline; }`,
      setup(ed) {
        ed.on('init', () => {
          try {
            // Ensure editor starts clean of any <mark> tags
            try { window.__clearEditorMarks?.(); } catch {}
            const hasAutosave = !!(ed.plugins && ed.plugins.autosave);
            if (hasAutosave && typeof ed.plugins.autosave.hasDraft === 'function') {
              const hasDraft = !!ed.plugins.autosave.hasDraft();
              const isEmpty = !ed.getContent({ format: 'text' }).trim();
              if (hasDraft && isEmpty && typeof ed.plugins.autosave.restore === 'function') {
                try { ed.plugins.autosave.restore(); } catch {}
              }
            }
            if (!ed.getContent({ format: 'text' }).trim()) {
              try {
                const saved = localStorage.getItem(STORAGE_KEY);
                if (typeof saved === 'string' && saved.length) {
                  ed.setContent(saved);
                }
              } catch {}
            }
          } catch {}
          setPlaceholder(placeholder);
        });
        // When content is replaced (e.g., switching articles), clean up <mark> tags
        ed.on('SetContent', () => { try { window.__clearEditorMarks?.(); } catch {} });
        const persistManual = () => {
          try {
            const html = ed.getContent();
            localStorage.setItem(STORAGE_KEY, html);
          } catch {}
        };
        ed.on('change', () => { persistManual(); });
        ed.on('keyup', () => {});
      }
    });
    editorInstance = Array.isArray(editorInstance) ? editorInstance[0] : editorInstance;
  } else {
    area.setAttribute('contenteditable', 'true');
    setPlaceholder(placeholder);
    editorInstance = {
      getContent(opts) {
        const format = opts?.format || opts?.as;
        if (format === 'text') return (area.innerText || area.textContent || '').trim();
        return area.innerHTML;
      },
      setContent(html) { area.innerHTML = html; },
      getBody() { return area; }
    };
    // Restore saved content
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (typeof saved === 'string' && saved.length) {
        area.innerHTML = saved;
      }
    } catch {}
    // Persist on input
    const persist = () => {
      try { localStorage.setItem(STORAGE_KEY, area.innerHTML); } catch {}
    };
    area.addEventListener('input', persist);
    try { window.addEventListener('beforeunload', persist); } catch {}
  }
  return editorInstance;
}

export function getContent({ as = 'html' } = {}) {
  if (!editorInstance) throw new Error('Editor not initialized');
  if (window.tinymce && editorInstance?.getContent) {
    return as === 'text' ? editorInstance.getContent({ format: 'text' }) : editorInstance.getContent();
  }
  const body = editorInstance.getBody?.() || document.querySelector('#docArea');
  if (as === 'text') return (body.innerText || body.textContent || '').trim();
  return body.innerHTML;
}

export function setPlaceholder(text) {
  const body = (window.tinymce && editorInstance?.getBody?.()) || document.querySelector('#docArea');
  if (!body) return;
  body.setAttribute('data-placeholder', text);
  body.setAttribute('data-empty', String(!body.innerText?.trim()));
  const observer = new MutationObserver(() => {
    body.setAttribute('data-empty', String(!body.innerText?.trim()));
  });
  observer.observe(body, { childList: true, subtree: true, characterData: true });
}


