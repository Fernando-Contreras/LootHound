// Helpers de DOM. Sin framework: crear elementos, escapar texto, avisos.

/** Crea un elemento. `props` acepta class, dataset, on*, y atributos sueltos. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

// ---------------------------------------------------------------- avisos
let toastHost = null;

export function toast(message, kind = 'info', ms = 4000) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: `toast toast--${kind}` }, message);
  toastHost.append(node);
  setTimeout(() => {
    node.classList.add('toast--out');
    setTimeout(() => node.remove(), 250);
  }, ms);
}

/** Confirmación modal. Devuelve una promesa que resuelve a true/false. */
export function confirmDialog(title, body, { okLabel = 'Sí, continuar', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'modal' },
      el('h3', {}, title),
      el('p', { class: 'muted' }, body),
      el('div', { class: 'modal__actions' },
        el('button', {
          class: 'btn btn--ghost', onclick: () => { dlg.close(); resolve(false); },
        }, 'Cancelar'),
        el('button', {
          class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
          onclick: () => { dlg.close(); resolve(true); },
        }, okLabel),
      ),
    );
    dlg.addEventListener('close', () => { dlg.remove(); resolve(false); }, { once: true });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Deshabilita un botón mientras corre una promesa. */
export async function withBusy(button, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.classList.add('is-busy');
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
    button.textContent = original;
  }
}
