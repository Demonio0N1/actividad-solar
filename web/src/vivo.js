// Página pública "Monitoreo del Sol en vivo": muestra resultados, no ejecuciones.
// Se recarga sola cuando la actualización diaria (o el laboratorio) reescribe tablas, figuras o
// el modelo publicado.
import './vivo.css'
import { alCambiarArchivo, alCambiarTema, escapar, hace, indicadorConexion, token } from './comun.js'
import {
  $, ajustarCanvas, colocarTooltip, eje, fechaDia, fechaMes, FUENTE_EJES, leerCSV, num, numero,
  registrarGrafico, rehacerGraficos, rgba, uPlot,
} from './graficos.js'
import { iniciarSol, verDia } from './sol.js'
import { crearVisorLatitud, crearVisorSerie, htmlParametros, htmlResumen, mostrarEcuacion } from './visor.js'

indicadorConexion()

const mtimes = new Map()
const frescos = new Map()

// ───────────────────────── Estado de los datos ─────────────────────────
function actualizarEstadoDatos() {
  const el = $('estado-datos')
  const ultimo = Math.max(0, ...[...mtimes.values()])
  if (!ultimo) {
    el.textContent = 'Aún no hay datos procesados en el servidor.'
    return
  }
  const fecha = new Date(ultimo).toLocaleString('es', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
  el.innerHTML = `Datos actualizados <b>${hace(ultimo)}</b> (${escapar(fecha)}). Se actualizan solos una vez al día.`
}

// ───────────────────────── Manchas y fulguraciones por mes ─────────────────────────
let gManchas = null
let gFulg = null

async function cargarMensual() {
  let filas
  try {
    filas = await leerCSV('/datos/indices_mensuales.csv')
  } catch {
    $('act-mensual').textContent = 'sin datos todavía'
    return
  }
  const x = filas.map((f) => Date.parse(f.mes_inicio + 'T00:00:00Z') / 1000)
  const manchas = filas.map((f) => num(f.manchas))
  const suav = filas.map((f) => num(f.manchas_13m))
  const mx = filas.map((f) => (num(f.n_M) ?? 0) + (num(f.n_X) ?? 0))
  const ejeX = () => eje({ size: 28, values: (u, v) => v.map((s) => new Date(s * 1000).getUTCFullYear()) })
  const serieX = { label: 'Mes', value: (u, v) => (v == null ? '–' : fechaMes(v)) }
  if (!gManchas) {
    gManchas = registrarGrafico($('g-manchas'), () => ({
      height: 190,
      cursor: { sync: { key: 'mensual' } },
      axes: [ejeX(), eje({ size: 40 })],
      series: [
        serieX,
        { label: 'Manchas (mensual)', stroke: rgba(token('--serie-1'), 0.4), width: 1, value: (u, v) => numero(v) },
        { label: 'Media 13 meses', stroke: token('--serie-1'), width: 2.5, value: (u, v) => numero(v) },
      ],
    }), [x, manchas, suav])
    gFulg = registrarGrafico($('g-fulguraciones'), () => ({
      height: 150,
      cursor: { sync: { key: 'mensual' } },
      axes: [ejeX(), eje({ size: 40 })],
      series: [
        serieX,
        { label: 'Fulguraciones M + X por mes', stroke: token('--serie-2'), fill: token('--serie-2'),
          paths: uPlot.paths.bars({ size: [0.75, 8] }), points: { show: false } },
      ],
    }), [x, mx])
  } else {
    gManchas.poner([x, manchas, suav])
    gFulg.poner([x, mx])
  }
  frescos.set('act-mensual', Date.now())
  actualizarEtiquetas()
}

// ───────────────────────── Diagrama mariposa observado ─────────────────────────
let obs = null
const MARGEN_OBS = { l: 42, r: 10, t: 8, b: 26 }
const LAT_OBS = 60

async function cargarMariposa() {
  try {
    const r = await fetch('/api/mariposa', { cache: 'no-store' })
    if (!r.ok) throw new Error()
    obs = await r.json()
    $('obs-vacio').hidden = true
  } catch {
    obs = null
    $('obs-vacio').hidden = false
    return
  }
  let c = 0
  for (const letra of obs.clase) if (letra === 'C') c++
  $('leyenda-mariposa').innerHTML =
    `<span><i style="background:var(--serie-1)"></i>Clase C (${c.toLocaleString('es')})</span>` +
    `<span><i style="background:var(--serie-2)"></i>Clases M y X (${(obs.clase.length - c).toLocaleString('es')})</span>` +
    `<span class="suave">clic en un punto para ver el Sol ese día</span>`
  frescos.set('act-mariposa', Date.now())
  dibujarMariposa()
  actualizarEtiquetas()
}

function escalaObs(w, h) {
  const m = MARGEN_OBS
  const t0 = Date.UTC(new Date(obs.t[0]).getUTCFullYear(), 0, 1) // obs.t viene ordenado
  const t1 = Date.UTC(new Date(obs.t.at(-1)).getUTCFullYear() + 1, 0, 1)
  const pw = w - m.l - m.r
  const ph = h - m.t - m.b
  return {
    m, pw, ph, t0, t1,
    x: (t) => m.l + ((t - t0) / (t1 - t0)) * pw,
    y: (lat) => m.t + ((LAT_OBS - lat) / (2 * LAT_OBS)) * ph,
  }
}

function dibujarMariposa() {
  if (!obs || !obs.t.length) return
  const { ctx, w, h } = ajustarCanvas($('obs-canvas'))
  const e = escalaObs(w, h)
  ctx.clearRect(0, 0, w, h)
  ctx.font = FUENTE_EJES
  ctx.fillStyle = token('--ink-3')
  ctx.strokeStyle = token('--grid')
  ctx.lineWidth = 1
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const lat of [60, 40, 20, 0, -20, -40, -60]) {
    const y = Math.round(e.y(lat)) + 0.5
    ctx.beginPath()
    ctx.moveTo(e.m.l, y)
    ctx.lineTo(e.m.l + e.pw, y)
    ctx.stroke()
    ctx.fillText(`${lat}°`, e.m.l - 6, y)
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const a0 = new Date(e.t0).getUTCFullYear()
  const a1 = new Date(e.t1).getUTCFullYear()
  const salto = e.pw < 420 ? 8 : 4
  for (let a = Math.ceil(a0 / salto) * salto; a <= a1; a += salto) {
    const x = Math.round(e.x(Date.UTC(a, 0, 1))) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, e.m.t)
    ctx.lineTo(x, e.m.t + e.ph)
    ctx.stroke()
    ctx.fillText(String(a), x, e.m.t + e.ph + 6)
  }
  ctx.fillStyle = rgba(token('--serie-1'), 0.35)
  for (let k = 0; k < obs.t.length; k++) {
    if (obs.clase[k] !== 'C') continue
    ctx.fillRect(e.x(obs.t[k]) - 1, e.y(obs.lat[k]) - 1, 2, 2)
  }
  ctx.fillStyle = rgba(token('--serie-2'), 0.75)
  for (let k = 0; k < obs.t.length; k++) {
    if (obs.clase[k] === 'C') continue
    ctx.beginPath()
    ctx.arc(e.x(obs.t[k]), e.y(obs.lat[k]), 1.8, 0, Math.PI * 2)
    ctx.fill()
  }
}

let obsElegido = -1
$('obs-canvas').addEventListener('mousemove', (ev) => {
  const tip = $('obs-tooltip')
  if (!obs) return
  const r = ev.currentTarget.getBoundingClientRect()
  const e = escalaObs(r.width, r.height)
  const x = ev.clientX - r.left
  const y = ev.clientY - r.top
  let mejor = -1
  let dist = 100 // 10 px al cuadrado
  for (let k = 0; k < obs.t.length; k++) {
    const dx = e.x(obs.t[k]) - x
    const dy = e.y(obs.lat[k]) - y
    const d2 = dx * dx + dy * dy
    if (d2 < dist) {
      dist = d2
      mejor = k
    }
  }
  obsElegido = mejor
  ev.currentTarget.style.cursor = mejor >= 0 ? 'pointer' : 'crosshair'
  if (mejor < 0) {
    tip.hidden = true
    return
  }
  const lat = obs.lat[mejor]
  colocarTooltip(tip, x, y, r.width,
    `Clase <b>${obs.clase[mejor]}</b><br>${fechaDia(obs.t[mejor])}<br>λ = <b>${lat > 0 ? '+' : ''}${lat}°</b> (${lat >= 0 ? 'norte' : 'sur'})<br><span class="suave">clic: ver el Sol ese día</span>`)
})
$('obs-canvas').addEventListener('mouseleave', () => {
  $('obs-tooltip').hidden = true
  obsElegido = -1
})
$('obs-canvas').addEventListener('click', () => {
  if (obsElegido < 0) return
  const iso = new Date(obs.t[obsElegido]).toISOString()
  verDia(iso.slice(0, 10), iso.slice(11, 13) + iso.slice(14, 16))
})

// ───────────────────────── Modelo publicado ─────────────────────────
let visor = null
let geometriaVisor = null

async function cargarPublicado() {
  let c
  try {
    const r = await fetch('/datos/modelo_publicado.json', { cache: 'no-store' })
    if (!r.ok) throw new Error()
    c = await r.json()
  } catch {
    $('pub-nombre').textContent = 'Aún no hay un modelo publicado'
    return
  }
  if (geometriaVisor !== c.tipo) {
    visor = c.tipo === 'serie' ? crearVisorSerie($('pub-visor')) : crearVisorLatitud($('pub-visor'))
    geometriaVisor = c.tipo
  }
  visor.cargar(c)
  $('pub-nombre').textContent = c.nombre
  $('pub-numero').textContent = `modelo ${c.numero}`
  $('pub-fecha').textContent = `calculado ${hace(Date.parse(c.fecha))}`
  $('pub-refs').textContent = c.referencias?.length ? `Referencias: ${c.referencias.join(' · ')}` : ''
  $('pub-resumen').innerHTML = htmlResumen(c)
  $('pub-parametros').innerHTML = htmlParametros(c)
  mostrarEcuacion($('pub-ecuacion'), c.ecuacion)
}

// ───────────────────────── Figuras ─────────────────────────
const figuras = new Map()
const DESCRIPCION = {
  'fig1_ciclos.png': 'Manchas solares y fulguraciones por mes, 1995 a hoy',
  'fig2_mariposa_observada.png': 'Latitud de las fulguraciones según el tiempo',
  'fig3_goes_diario.png': 'Rayos X, EUV 30.4 nm, Mg II y manchas diarias desde 2017',
  'fig4_ley_potencia.png': 'Distribución del flujo pico de las fulguraciones',
  'fig5_mariposa_modelo.png': 'Diagrama mariposa simulado por el modelo de dínamo',
}

function htmlFigura(nombre, f) {
  const src = `/figuras/${encodeURIComponent(nombre)}?v=${Math.round(f.mtime)}`
  return `<figure data-nombre="${escapar(nombre)}">
    <a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${escapar(DESCRIPCION[nombre] ?? nombre)}" loading="lazy"></a>
    <figcaption><span>${escapar(DESCRIPCION[nombre] ?? nombre)}</span><span class="cuando"></span></figcaption>
  </figure>`
}

function renderFiguras() {
  const el = $('figuras')
  if (!figuras.size) {
    el.innerHTML = '<p class="suave">Aún no hay figuras.</p>'
    return
  }
  el.innerHTML = [...figuras].sort(([a], [b]) => a.localeCompare(b)).map(([n, f]) => htmlFigura(n, f)).join('')
  actualizarEtiquetas()
}

function figuraCambiada({ nombre, mtime }) {
  if (!nombre.endsWith('.png')) return
  if (mtime == null) {
    figuras.delete(nombre)
    return renderFiguras()
  }
  const nueva = !figuras.has(nombre)
  figuras.set(nombre, { mtime, cambio: Date.now() })
  const fig = document.querySelector(`#figuras figure[data-nombre="${CSS.escape(nombre)}"]`)
  if (nueva || !fig) return renderFiguras()
  const src = `/figuras/${encodeURIComponent(nombre)}?v=${Math.round(mtime)}`
  fig.querySelector('img').src = src
  fig.querySelector('a').href = src
  actualizarEtiquetas()
}

async function cargarArchivos() {
  try {
    const { figuras: lista, datos } = await (await fetch('/api/archivos', { cache: 'no-store' })).json()
    for (const f of lista) figuras.set(f.nombre, { mtime: f.mtime, cambio: null })
    for (const d of datos) mtimes.set(d.nombre, d.mtime)
  } catch {
    // sin servidor: secciones vacías
  }
  renderFiguras()
  actualizarEstadoDatos()
}

function actualizarEtiquetas() {
  const ahora = Date.now()
  for (const fig of document.querySelectorAll('#figuras figure')) {
    const f = figuras.get(fig.dataset.nombre)
    if (!f) continue
    fig.classList.toggle('actualizada', !!(f.cambio && ahora - f.cambio < 4000))
    fig.querySelector('.cuando').textContent = f.cambio ? `actualizada ${hace(f.cambio)}` : hace(f.mtime)
  }
  for (const [id, archivo] of [['act-mensual', 'indices_mensuales.csv'], ['act-mariposa', 'fulguraciones.csv']]) {
    const leido = frescos.get(id)
    if (!leido) continue
    const mt = mtimes.get(archivo)
    $(id).textContent = mt ? `actualizado ${hace(mt)}` : ''
    $(id).classList.toggle('fresco', ahora - leido < 5000)
  }
}

// ───────────────────────── Arranque ─────────────────────────
alCambiarArchivo((a) => {
  if (a.carpeta === '/figuras/') figuraCambiada(a)
  if (a.carpeta !== '/datos/') return
  if (a.mtime) mtimes.set(a.nombre, a.mtime)
  actualizarEstadoDatos()
  if (a.nombre === 'indices_mensuales.csv') cargarMensual()
  if (a.nombre === 'fulguraciones.csv') cargarMariposa()
  if (a.nombre === 'modelo_publicado.json') cargarPublicado()
})

alCambiarTema(() => {
  rehacerGraficos()
  visor?.alTema()
  dibujarMariposa()
})
new ResizeObserver(() => dibujarMariposa()).observe($('obs'))
setInterval(() => {
  actualizarEtiquetas()
  actualizarEstadoDatos()
}, 30000)

iniciarSol()
cargarArchivos()
cargarMensual()
cargarMariposa()
cargarPublicado()
