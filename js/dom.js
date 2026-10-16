// Helpers de DOM. Sin framework: crear elementos, escapar texto, avisos.

/**
 * Crea un elemento. `props` acepta class, dataset, on*, y atributos sueltos.
 *
 * Seguridad: adrede NO existe una opción `html`. Los nombres de comercios y de
 * quien te transfiere vienen de PDFs y de terceros, así que todo texto entra
 * por createTextNode: un nombre malicioso no puede inyectar HTML ni scripts.
 * Y una clave `on…` sólo se acepta con una FUNCIÓN; con un texto se ignora, para
 * que nunca se cree un manejador en línea (`onclick="..."`).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (/^on/i.test(k)) {
      if (typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      continue;
    }
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
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

/**
 * Diálogo con un formulario, validación por campo y guardado.
 *
 * @param {object} cfg
 * @param {string} cfg.title
 * @param {Array<{name,label,type?,value?,options?:Array<[value,label]>,step?,
 *                inputmode?,maxlength?,placeholder?,wide?}>} cfg.fields
 * @param {(values:object)=>{ok:boolean, errors:object, value?:any}} cfg.validate
 * @param {(value:any)=>Promise<void>} cfg.save  corre sólo si validó
 * @param {string} [cfg.note]
 */
export function formDialog({ title, fields, validate, save, note = null, submitLabel = 'Guardar' }) {
  const control = (f) => (f.options
    ? el('select', { name: f.name },
        f.options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(f.value ?? '') }, l)))
    : el('input', {
        name: f.name, type: f.type || 'text', value: f.value ?? '', step: f.step,
        inputmode: f.inputmode, maxlength: f.maxlength, placeholder: f.placeholder,
      }));

  const form = el('form', { class: 'editform', novalidate: true },
    el('h3', {}, title),
    el('div', { class: 'editform__grid' },
      fields.map((f) => el('label', { class: `editform__field${f.wide ? ' editform__field--wide' : ''}` },
        el('span', {}, f.label), control(f),
        el('small', { class: 'field-error', dataset: { error: f.name }, hidden: true })))),
    note && el('p', { class: 'note' }, note),
    el('div', { class: 'modal__actions' },
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => dlg.close() }, 'Cancelar'),
      el('button', { class: 'btn btn--primary', type: 'submit' }, submitLabel)),
  );
  const dlg = el('dialog', { class: 'modal modal--wide' }, form);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });

  const showErrors = (errors = {}) => {
    for (const small of form.querySelectorAll('.field-error')) {
      const msg = errors[small.dataset.error];
      small.textContent = msg || '';
      small.hidden = !msg;
    }
    const first = Object.keys(errors)[0];
    if (first) form.elements[first]?.focus();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = validate(Object.fromEntries(new FormData(form).entries()));
    showErrors(res.errors);
    if (!res.ok) return;
    await withBusy(form.querySelector('button[type=submit]'), async () => {
      try {
        await save(res.value);
        dlg.close();
      } catch (err) {
        toast(err?.message || 'No se pudo guardar.', 'error', 8000);
      }
    });
  });

  document.body.append(dlg);
  dlg.showModal();
  return dlg;
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
