// Gráficas en SVG, sin librerías. Los datos ya vienen calculados por
// finance.js — aquí sólo se dibujan.

import { el } from './dom.js';
import { formatMoney } from './finance.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Dona de gasto por categoría.
 * @param {Array<{name,amount,color,share}>} slices
 */
export function donut(slices, { size = 220, thickness = 28, centerLabel, centerValue } = {}) {
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img',
    'aria-label': 'Gasto por categoría',
  });

  const total = slices.reduce((a, s) => a + s.amount, 0);
  if (total <= 0) {
    svg.append(svgEl('circle', {
      cx, cy, r, fill: 'none', stroke: 'var(--line)', 'stroke-width': thickness,
    }));
  } else {
    let offset = 0;
    for (const s of slices) {
      const len = (s.amount / total) * circumference;
      const arc = svgEl('circle', {
        cx, cy, r, fill: 'none',
        stroke: s.color,
        'stroke-width': thickness,
        'stroke-dasharray': `${len} ${circumference - len}`,
        'stroke-dashoffset': -offset,
        transform: `rotate(-90 ${cx} ${cy})`,
        class: 'donut__arc',
      });
      const title = svgEl('title');
      title.textContent = `${s.name}: ${formatMoney(s.amount)} (${Math.round(s.share * 100)}%)`;
      arc.append(title);
      svg.append(arc);
      offset += len;
    }
  }

  if (centerValue !== undefined) {
    const v = svgEl('text', {
      x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'donut__value',
    });
    v.textContent = centerValue;
    svg.append(v);
  }
  if (centerLabel) {
    const l = svgEl('text', {
      x: cx, y: cy + 18, 'text-anchor': 'middle', class: 'donut__label',
    });
    l.textContent = centerLabel;
    svg.append(l);
  }
  return svg;
}

/** Leyenda de la dona. */
export function legend(slices, { onSelect } = {}) {
  return el('ul', { class: 'legend' },
    slices.map((s) => el('li', {
      class: 'legend__item',
      onclick: onSelect ? () => onSelect(s) : null,
      role: onSelect ? 'button' : null,
      tabindex: onSelect ? '0' : null,
    },
      el('span', { class: 'legend__dot', style: { background: s.color } }),
      el('span', { class: 'legend__name' }, s.name),
      el('span', { class: 'legend__pct' }, `${Math.round(s.share * 100)}%`),
      el('span', { class: 'legend__amount' }, formatMoney(s.amount)),
    )),
  );
}

/**
 * Barras ingresos vs gastos por mes.
 * @param {Array<{month,income,expense,net}>} months
 */
export function monthlyBars(months, { height = 160 } = {}) {
  if (!months.length) return el('p', { class: 'muted' }, 'Sin datos todavía.');

  const max = Math.max(...months.map((m) => Math.max(m.income, m.expense)), 1);
  return el('div', { class: 'bars' },
    months.map((m) => el('div', { class: 'bars__col', title: `${m.month}` },
      el('div', { class: 'bars__pair', style: { height: `${height}px` } },
        el('div', {
          class: 'bars__bar bars__bar--in',
          style: { height: `${(m.income / max) * 100}%` },
          title: `Ingresos ${formatMoney(m.income)}`,
        }),
        el('div', {
          class: 'bars__bar bars__bar--out',
          style: { height: `${(m.expense / max) * 100}%` },
          title: `Gastos ${formatMoney(m.expense)}`,
        }),
      ),
      el('span', { class: 'bars__label' }, m.month.slice(5)),
    )),
  );
}

/** Barra horizontal simple, para "top comercios". */
export function rankBars(items, { max = null, color = 'var(--accent)' } = {}) {
  const top = max ?? Math.max(...items.map((i) => i.amount), 1);
  return el('ul', { class: 'rank' },
    items.map((i) => el('li', { class: 'rank__row' },
      el('span', { class: 'rank__name' }, i.description),
      el('span', { class: 'rank__track' },
        el('span', {
          class: 'rank__fill',
          style: { width: `${(i.amount / top) * 100}%`, background: color },
        }),
      ),
      el('span', { class: 'rank__value' }, formatMoney(i.amount)),
    )),
  );
}
