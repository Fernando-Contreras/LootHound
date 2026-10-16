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

/**
 * Líneas en el tiempo (valor vs. aportado). SVG a mano, sin librerías.
 * El eje X es proporcional a la FECHA (no al número de puntos), así que dos
 * fotos con meses de distancia no se dibujan pegadas.
 *
 * @param {Array<{label:string,color:string,dashed?:boolean,points:Array<{date:string,y:number}>}>} series
 */
export function lineChart(series, { width = 640, height = 220, formatY = formatMoney } = {}) {
  const padL = 64; const padR = 14; const padT = 14; const padB = 26;
  const all = series.flatMap((s) => s.points);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, class: 'linechart', role: 'img',
    'aria-label': series.map((s) => s.label).join(' vs '),
  });
  if (all.length < 2) {
    const t = svgEl('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'donut__label' });
    t.textContent = 'Hacen falta al menos dos fechas con valor para dibujar la línea.';
    svg.append(t);
    return svg;
  }

  const t = (d) => Date.parse(`${d}T00:00:00Z`);
  const t0 = Math.min(...all.map((p) => t(p.date)));
  const t1 = Math.max(...all.map((p) => t(p.date)));
  const yMin = Math.min(0, ...all.map((p) => p.y));
  const yMax = Math.max(...all.map((p) => p.y)) || 1;
  const x = (d) => padL + ((t(d) - t0) / Math.max(1, t1 - t0)) * (width - padL - padR);
  const y = (v) => padT + (1 - (v - yMin) / Math.max(1e-9, yMax - yMin)) * (height - padT - padB);

  // rejilla: 3 líneas horizontales con su valor
  for (let i = 0; i <= 3; i++) {
    const v = yMin + ((yMax - yMin) * i) / 3;
    svg.append(svgEl('line', { x1: padL, x2: width - padR, y1: y(v), y2: y(v), stroke: 'var(--line)', 'stroke-width': 1 }));
    const lab = svgEl('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'donut__label' });
    lab.textContent = formatY(v).replace(/\.00$/, '');
    svg.append(lab);
  }
  // fechas de los extremos
  for (const [d, anchor] of [[all.map((p) => p.date).sort()[0], 'start'], [all.map((p) => p.date).sort().pop(), 'end']]) {
    const lab = svgEl('text', { x: x(d), y: height - 6, 'text-anchor': anchor, class: 'donut__label' });
    lab.textContent = d;
    svg.append(lab);
  }

  for (const s of series) {
    const pts = [...s.points].sort((a, b) => a.date.localeCompare(b.date));
    svg.append(svgEl('polyline', {
      points: pts.map((p) => `${x(p.date)},${y(p.y)}`).join(' '),
      fill: 'none', stroke: s.color, 'stroke-width': 2.2, 'stroke-linejoin': 'round',
      ...(s.dashed ? { 'stroke-dasharray': '5 4' } : {}),
    }));
    for (const p of pts) {
      const dot = svgEl('circle', { cx: x(p.date), cy: y(p.y), r: 3, fill: s.color });
      const title = svgEl('title');
      title.textContent = `${s.label} · ${p.date}: ${formatY(p.y)}`;
      dot.append(title);
      svg.append(dot);
    }
  }
  return svg;
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
