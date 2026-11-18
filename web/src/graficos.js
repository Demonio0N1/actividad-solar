// Utilidades de dibujo compartidas por la página pública y el laboratorio.
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { token } from './comun.js'

export const $ = (id) => document.getElementById(id)
export const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export const FUENTE_EJES = '12px "Source Sans 3", system-ui, sans-serif'

export function rgb(hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
export function rgba(hex, a) {
  const [r, g, b] = rgb(hex)
  return `rgba(${r},${g},${b},${a})`
}
export function segundos(s) {
  if (s == null) return ''
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}
export function hora(ms) {
  return new Date(ms).toLocaleTimeString('es', { hour12: false })
}
export function fechaMes(seg) {
  const d = new Date(seg * 1000)
  return `${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
export function fechaDia(ms) {
  const d = new Date(ms)
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
export function numero(x) {
  if (x == null || !isFinite(x)) return '–'
  if (x !== 0 && Math.abs(x) < 0.01) return x.toExponential(1)
  return x.toLocaleString('es', { maximumFractionDigits: 3 })
}

/** Ajusta el canvas a su tamaño en pantalla y a la densidad de píxeles. */
export function ajustarCanvas(canvas) {
  const r = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(r.width * dpr))
  const h = Math.max(1, Math.round(r.height * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, w: r.width, h: r.height }
}

export function colocarTooltip(tip, x, y, ancho, html) {
  tip.innerHTML = html
  tip.hidden = false
  tip.style.left = `${x}px`
  tip.style.top = `${y}px`
  tip.style.transform = x > ancho - 190 ? 'translate(calc(-100% - 12px), -50%)' : 'translate(12px, -50%)'
}

// ── uPlot ──
const graficos = []

export function eje(extra = {}) {
  return {
    stroke: token('--ink-3'),
    font: FUENTE_EJES,
    labelFont: FUENTE_EJES,
    grid: { stroke: token('--grid'), width: 1 },
    ticks: { stroke: token('--grid'), width: 1, size: 4 },
    ...extra,
  }
}

/** Crea un gráfico uPlot que se ajusta al ancho del contenedor y se rehace al cambiar el tema. */
export function registrarGrafico(el, opciones, datos) {
  const g = { el, opciones, datos, u: null }
  g.crear = () => {
    g.u?.destroy()
    g.u = new uPlot({ ...g.opciones(), width: Math.max(200, el.clientWidth) }, g.datos, el)
  }
  g.poner = (datos) => {
    g.datos = datos
    g.u ? g.u.setData(datos) : g.crear()
  }
  new ResizeObserver(() => g.u?.setSize({ width: Math.max(200, el.clientWidth), height: g.u.height })).observe(el)
  graficos.push(g)
  g.crear()
  return g
}

/** Vuelve a crear todos los gráficos (por ejemplo, al cambiar de tema claro a oscuro). */
export function rehacerGraficos() {
  for (const g of graficos) g.crear()
}

export { uPlot }

// ── Tablas ──
export async function leerCSV(url) {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  const [cab, ...filas] = (await r.text()).trim().split('\n')
  const cols = cab.split(',')
  return filas.map((f) => {
    const v = f.split(',')
    return Object.fromEntries(cols.map((c, i) => [c, v[i]]))
  })
}
export const num = (s) => (s === '' || s == null ? null : Number(s))
