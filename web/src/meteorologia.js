// Pestaña "Meteorología": red de estaciones del OAQ (Panel, Explorador, Calidad y eventos).
// Lee lo que genera src/meteorologia.py en data/processed/meteo/ (servido en /datos/meteo/).
//
// Horas: los datos están en hora local de Ecuador (UTC−5) sin zona. Para dibujar se leen como si
// fueran UTC ("reloj de pared") y uPlot dibuja en UTC; para calcular antigüedades se usa la hora real.
import './vivo.css'
import './meteorologia.css'
import { alCambiarTema, escapar, hace, token } from './comun.js'
import { $, eje, leerCSV, MESES, num, rgba, uPlot } from './graficos.js'

const BASE = '/datos/meteo'
const UTC_ECUADOR = '-05:00'
const D = 86400
const COLORES = ['--serie-1', '--serie-2', '--serie-3', '--serie-4']
const ACTIVA_H = 24 // criterio de actividad del proyecto
const MAX_DIAS_5MIN = 62
const MAX_FILAS = 500
const NOMBRES_FECHA = {
  MMMM: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  MMM: MESES,
  WWWW: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  WWW: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
}
// Marcas del eje de tiempo en español, reloj de 24 h
const MARCAS_TIEMPO = [
  [365 * D, '{YYYY}', null, null, null, null, null, null, 1],
  [28 * D, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
  [D, '{D} {MMM}', '\n{YYYY}', null, null, null, null, null, 1],
  [3600, '{HH}:{mm}', '\n{D} {MMM} {YYYY}', null, '\n{D} {MMM}', null, null, null, 1],
  [60, '{HH}:{mm}', '\n{D} {MMM} {YYYY}', null, '\n{D} {MMM}', null, null, null, 1],
]
const AGREGACION = { media: 'media', maximo: 'máximo', circular: 'media circular', ultimo: 'último valor' }
const DESDE_CERO = ['radiacion_solar', 'uv', 'velocidad_viento', 'rafaga_viento', 'lluvia_intensidad', 'lluvia_evento',
  'lluvia_diaria', 'lluvia_semana', 'lluvia_mes', 'lluvia_anio']
const DEC = { temperatura: 1, humedad: 0, presion: 1, radiacion_solar: 0, uv: 0, velocidad_viento: 1, rafaga_viento: 1, direccion_viento: 0 }

const m = { meta: null, porVariable: {}, color: {}, cache: new Map() }
let ultimaConsulta = null

// ───────────────────────── Utilidades ─────────────────────────
/** "2026-11-17 16:55:24", "2026-11-17T16:55" o "2026-11-17" (hora local) -> segundos de reloj de pared. */
function pared(s) {
  const t = s.replace(' ', 'T')
  if (t.length === 10) return Date.parse(`${t}T00:00:00Z`) / 1000
  return Date.parse(`${t.length === 16 ? t + ':00' : t.slice(0, 19)}Z`) / 1000
}
/** Momento real (ms) de una hora local. */
const real = (s) => Date.parse(s.replace(' ', 'T').slice(0, 19) + UTC_ECUADOR)

function fecha(seg, { hora = true } = {}) {
  const d = new Date(seg * 1000)
  const f = `${d.getUTCDate()} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  if (!hora) return f
  return `${f}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const fechaISO = (seg) => new Date(seg * 1000).toISOString().slice(0, 10)

function antiguedad(ms) {
  const h = (Date.now() - ms) / 3600e3
  return h < 48 ? hace(ms) : `hace ${Math.floor(h / 24)} días`
}

function fmt(x, decimales = 1) {
  if (x == null || !isFinite(x)) return '–'
  return x.toLocaleString('es', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })
}
const base = (c) => c.replace(/_(min|max)$/, '')
const dec = (v) => DEC[base(v)] ?? 1
const unidad = (v) => m.porVariable[base(v)]?.unidad ?? ''
const conUnidad = (v) => (unidad(v) ? `${m.porVariable[v].nombre} (${unidad(v)})` : m.porVariable[v].nombre)
const estacion = (t) => m.meta.estaciones.find((e) => e.tabla === t)
const nombreEst = (t) => estacion(t)?.nombre ?? t
const punto = (t) => `<i class="punto" style="background:var(${m.color[t]})"></i>`

/** Estado de la estación, calculado en el momento de la consulta. */
function estadoEstacion(e) {
  const ms = real(e.ultima_medicion)
  const h = (Date.now() - ms) / 3600e3
  const repite = real(e.ultimo_registro) - ms > 3600e3
  if (h < 1) return { clase: 'ok', texto: 'transmitiendo', h, repite }
  if (h < ACTIVA_H) return { clase: 'next', texto: `con retraso · ${antiguedad(ms)}`, h, repite }
  return { clase: 'error', texto: `sin mediciones · ${antiguedad(ms)}`, h, repite }
}

/** Eventos de corrección no documentada de una variable que se cruzan con [desde, hasta). */
function correcciones(tabla, variable, desde, hasta) {
  return m.meta.eventos.filter((ev) => {
    if (ev.tabla !== tabla || ev.tipo !== 'correccion_no_documentada' || !ev.variables.includes(variable)) return false
    const i = ev.inicio ? pared(ev.inicio) : -Infinity
    const f = ev.fin ? pared(ev.fin) : Infinity
    return i < hasta && f > desde
  })
}

// ───────────────────────── Gráficos (uPlot) ─────────────────────────
const conjuntos = new Map() // nombre -> [{ el, u, ro, crear }]
let sincronizando = false

function opcionesTiempo({ alto = 190, sync, marcadores = [], resaltar = null }) {
  return {
    height: alto,
    tzDate: (s) => uPlot.tzDate(new Date(s * 1000), 'Etc/UTC'),
    fmtDate: (tpl) => uPlot.fmtDate(tpl, NOMBRES_FECHA),
    cursor: { sync: { key: sync }, drag: { x: true, y: false } },
    legend: { show: true, live: true },
    axes: [eje({ size: 48, values: MARCAS_TIEMPO }), eje({ size: 52 })],
    hooks: {
      // un zoom del usuario en un gráfico se aplica a los demás del mismo conjunto
      setScale: [
        (u, clave) => {
          if (clave !== 'x' || sincronizando || u.status !== 1) return
          sincronizando = true
          for (const g of conjuntos.get(sync) ?? []) {
            if (g.u && g.u !== u && g.u.status === 1) g.u.setScale('x', { min: u.scales.x.min, max: u.scales.x.max })
          }
          sincronizando = false
        },
      ],
      draw: [(u) => dibujarMarcadores(u, marcadores), (u) => resaltar && dibujarResaltados(u, resaltar)],
    },
  }
}

/** Líneas verticales punteadas en las discontinuidades conocidas. */
function dibujarMarcadores(u, marcadores) {
  if (!marcadores.length) return
  const { ctx } = u
  const { top, height, left, width } = u.bbox
  const dpr = devicePixelRatio || 1
  ctx.save()
  ctx.strokeStyle = token('--ink-3')
  ctx.fillStyle = token('--ink-2')
  ctx.setLineDash([4 * dpr, 4 * dpr])
  ctx.lineWidth = dpr
  ctx.font = `${11 * dpr}px "Source Sans 3", system-ui, sans-serif`
  ctx.textBaseline = 'top'
  // etiquetas en filas para que no se encimen las de discontinuidades cercanas
  const filas = []
  for (const mk of [...marcadores].sort((a, b) => a.t - b.t)) {
    const x = Math.round(u.valToPos(mk.t, 'x', true))
    if (x < left || x > left + width) continue
    ctx.beginPath()
    ctx.moveTo(x + 0.5, top)
    ctx.lineTo(x + 0.5, top + height)
    ctx.stroke()
    const ancho = ctx.measureText(mk.corto).width
    const derecha = x + ancho + 8 * dpr > left + width
    const ini = derecha ? x - ancho - 4 * dpr : x + 4 * dpr
    let fila = filas.findIndex((fin) => ini > fin + 6 * dpr)
    if (fila < 0) fila = filas.push(0) - 1
    filas[fila] = ini + ancho
    ctx.textAlign = 'left'
    ctx.fillText(mk.corto, ini, top + (2 + fila * 13) * dpr)
  }
  ctx.restore()
}

/** Círculos sobre los valores marcados ("Incluir y resaltar"). resaltar[s] = índices del eje x de la serie s. */
function dibujarResaltados(u, resaltar) {
  const { ctx } = u
  const dpr = devicePixelRatio || 1
  ctx.save()
  ctx.strokeStyle = token('--error')
  ctx.lineWidth = 1.5 * dpr
  resaltar.forEach((indices, s) => {
    for (const i of indices) {
      const v = u.data[s + 1][i]
      if (v == null) continue
      ctx.beginPath()
      ctx.arc(u.valToPos(u.data[0][i], 'x', true), u.valToPos(v, 'y', true), 4 * dpr, 0, Math.PI * 2)
      ctx.stroke()
    }
  })
  ctx.restore()
}

function grafico(conjunto, el, opciones, datos) {
  const g = { el, opciones, datos, u: null }
  g.crear = () => {
    g.u?.destroy()
    g.u = new uPlot({ ...g.opciones(), width: Math.max(220, el.clientWidth) }, g.datos, el)
  }
  g.ro = new ResizeObserver(() => g.u?.setSize({ width: Math.max(220, el.clientWidth), height: g.u.height }))
  g.ro.observe(el)
  if (!conjuntos.has(conjunto)) conjuntos.set(conjunto, [])
  conjuntos.get(conjunto).push(g)
  g.crear()
  return g
}

function vaciarConjunto(conjunto) {
  for (const g of conjuntos.get(conjunto) ?? []) {
    g.ro.disconnect()
    g.u?.destroy()
  }
  conjuntos.set(conjunto, [])
}

/** Fija el mismo intervalo x en todos los gráficos de un conjunto (sin pasar por la sincronización). */
function fijarRango(conjunto, min, max) {
  sincronizando = true
  for (const g of conjuntos.get(conjunto) ?? []) g.u?.setScale('x', { min, max })
  sincronizando = false
}

function serieEstacion(tabla, v, { barras = false, pasos = false, puntos = false } = {}) {
  const color = token(m.color[tabla])
  const s = {
    label: nombreEst(tabla),
    stroke: color,
    width: barras ? 0 : 1.75,
    spanGaps: false,
    points: { show: false },
    value: (u, x) => fmt(x, dec(v)),
  }
  if (barras) Object.assign(s, { fill: rgba(color, 0.8), paths: uPlot.paths.bars({ size: [0.7, 10], align: 0 }) })
  if (pasos) s.paths = uPlot.paths.stepped({ align: 1 })
  if (puntos) Object.assign(s, { paths: () => null, points: { show: true, size: 4, fill: color, stroke: color } })
  return s
}

/**
 * Une series con ejes x distintos en un eje común. Donde una serie salta más de 1,5 pasos se
 * inserta un valor vacío, para que la línea se corte en los huecos en vez de unir puntos lejanos.
 */
function unir(series, paso) {
  const conHuecos = series.map(({ x, y }) => {
    const X = []
    const Y = []
    for (let i = 0; i < x.length; i++) {
      if (i > 0 && x[i] - x[i - 1] > 1.5 * paso) {
        X.push(x[i - 1] + paso)
        Y.push(null)
      }
      X.push(x[i])
      Y.push(y[i])
    }
    return { X, Y }
  })
  const todos = new Set()
  for (const s of conHuecos) for (const t of s.X) todos.add(t)
  const x = [...todos].sort((a, b) => a - b)
  const indice = new Map(x.map((t, i) => [t, i]))
  const ys = conHuecos.map(({ X, Y }) => {
    const y = new Array(x.length).fill(undefined) // undefined: sin dato en ese instante (no corta la línea)
    X.forEach((t, i) => (y[indice.get(t)] = Y[i]))
    return y
  })
  return { x, ys, indice }
}

// ───────────────────────── Pestañas ─────────────────────────
const SECCIONES = ['panel', 'explorador', 'calidad', 'datos']
function mostrarSeccion(nombre, { foco = false } = {}) {
  if (!SECCIONES.includes(nombre)) nombre = 'panel'
  for (const s of SECCIONES) {
    $(`sec-${s}`).hidden = s !== nombre
    $(`tab-${s}`).setAttribute('aria-selected', String(s === nombre))
    $(`tab-${s}`).tabIndex = s === nombre ? 0 : -1
  }
  if (foco) $(`tab-${nombre}`).focus()
  if (location.hash.slice(1) !== nombre) history.replaceState(null, '', `#${nombre}`)
  // un gráfico oculto no tiene ancho: se ajustan al mostrarse
  requestAnimationFrame(() => {
    for (const lista of conjuntos.values()) {
      for (const g of lista) g.u?.setSize({ width: Math.max(220, g.el.clientWidth), height: g.u.height })
    }
  })
}
for (const s of SECCIONES) $(`tab-${s}`).addEventListener('click', () => mostrarSeccion(s))
document.querySelector('.m-pestanas').addEventListener('keydown', (ev) => {
  const i = SECCIONES.findIndex((s) => $(`tab-${s}`).getAttribute('aria-selected') === 'true')
  if (ev.key === 'ArrowRight') mostrarSeccion(SECCIONES[(i + 1) % SECCIONES.length], { foco: true })
  if (ev.key === 'ArrowLeft') mostrarSeccion(SECCIONES[(i + SECCIONES.length - 1) % SECCIONES.length], { foco: true })
})
addEventListener('hashchange', () => mostrarSeccion(location.hash.slice(1)))

// ───────────────────────── Panel ─────────────────────────
function renderRed() {
  const est = m.meta.estaciones
  const estados = est.map(estadoEstacion)
  const activas = estados.filter((s) => s.h < ACTIVA_H).length
  const ultima = est.reduce((a, e) => (pared(e.ultima_medicion) > pared(a.ultima_medicion) ? e : a))
  const archivo = Math.max(...est.map((e) => Date.parse(e.archivo_modificado)))
  const ind = (dt, dd, nota = '') => `<div><dt>${dt}</dt><dd>${dd}</dd>${nota ? `<dd class="nota">${nota}</dd>` : ''}</div>`
  $('red-indicadores').innerHTML = [
    ind('Estaciones con mediciones en las últimas 24 h', `<b>${activas}</b> de ${est.length}`,
      activas < est.length ? 'Las demás aparecen en rojo en la tabla.' : ''),
    ind('Medición más reciente de la red', `<b>${antiguedad(real(ultima.ultima_medicion))}</b>`,
      `${escapar(fecha(pared(ultima.ultima_medicion)))} · ${escapar(ultima.nombre)}`),
    ind('Archivos de datos actualizados', `<b>${antiguedad(archivo)}</b>`, 'Fecha de modificación de los Parquet, que reescribe la adquisición'),
    ind('Datos procesados para esta página', `<b>${antiguedad(Date.parse(m.meta.generado))}</b>`),
  ].join('')
  $('red-consulta').textContent = `estado calculado a las ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`
  $('red-tabla').tBodies[0].innerHTML = est
    .map((e, i) => {
      const s = estados[i]
      return `<tr>
        <th scope="row">${punto(e.tabla)}${escapar(e.nombre)}</th>
        <td><span class="chip ${s.clase}">${escapar(s.texto)}</span></td>
        <td>${escapar(fecha(pared(e.ultima_medicion)))}</td>
        <td>${escapar(fecha(pared(e.ultimo_registro)))}${s.repite ? '<br><span class="m-alerta">repite el mismo registro sin cambios</span>' : ''}</td>
        <td>${escapar(new Date(Date.parse(e.archivo_modificado)).toLocaleString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
      </tr>`
    })
    .join('')
}

const INDICADORES = ['temperatura', 'humedad', 'presion', 'uv', 'velocidad_viento', 'lluvia_diaria']
const NOMBRE_INDICADOR = { presion: 'Presión (estación)', lluvia_diaria: 'Precipitación del día', velocidad_viento: 'Velocidad del viento' }

function renderTarjetas() {
  $('tarjetas').innerHTML = m.meta.estaciones
    .map((e) => {
      const s = estadoEstacion(e)
      const ref = e.ultima_medicion
      const valores = INDICADORES.map((v) => {
        const u = e.ultima[v]
        const t = u ? pared(u.tiempo) : null
        const precaucion = u && correcciones(e.tabla, v, t, t + 1).length
        const valor = v === 'lluvia_diaria' ? e.lluvia_dia_ultima_medicion : u?.valor
        return `<div${u ? ` title="Tabla ${escapar(e.tabla)} · id ${u.id} · ${escapar(u.tiempo.replace('T', ' '))}"` : ''}>
          <dt>${escapar(NOMBRE_INDICADOR[v] ?? m.porVariable[v].nombre)}${precaucion ? ' <span class="m-aviso-icono" title="Corrección no documentada: compare con precaución">▲</span>' : ''}</dt>
          <dd><b>${fmt(valor, dec(v))}</b> <span class="unidad">${escapar(unidad(v))}</span></dd>
          ${u && u.tiempo !== ref ? `<dd class="detalle">medido el ${escapar(fecha(t))}</dd>` : ''}
        </div>`
      }).join('')
      return `<article class="panel m-tarjeta">
        <header class="panel-cab">
          <h3>${punto(e.tabla)}${escapar(e.nombre)}</h3>
          <span class="chip ${s.clase}">${escapar(s.texto)}</span>
        </header>
        <p class="m-medido">Medido el <b>${escapar(fecha(pared(ref)))}</b> · ${escapar(antiguedad(real(ref)))}</p>
        ${s.repite ? `<p class="m-alerta">Desde esa hora la estación envía siempre el mismo registro: estos valores no son actuales.</p>` : ''}
        <dl class="m-seis">${valores}</dl>
        <a class="boton-texto m-ver" href="#explorador" data-estacion="${escapar(e.tabla)}">Ver sus últimos 3 días en el explorador</a>
      </article>`
    })
    .join('')
}

$('tarjetas').addEventListener('click', (ev) => {
  const a = ev.target.closest('.m-ver')
  if (!a) return
  ev.preventDefault()
  const e = estacion(a.dataset.estacion)
  for (const c of document.querySelectorAll('#q-estaciones input')) c.checked = c.value === e.tabla
  const fin = pared(e.ultima_medicion)
  $('q-hasta').value = fechaISO(fin)
  $('q-desde').value = fechaISO(fin - 2 * D)
  actualizarAyuda()
  mostrarSeccion('explorador')
  consultar()
})

async function renderReciente() {
  let filas
  try {
    filas = await leerCSV(`${BASE}/reciente.csv?v=${encodeURIComponent(m.meta.generado)}`)
  } catch {
    return
  }
  const tablas = m.meta.estaciones.map((e) => e.tabla)
  const porTabla = Object.fromEntries(tablas.map((t) => [t, []]))
  for (const f of filas) porTabla[f.tabla]?.push(f)
  const presentes = tablas.filter((t) => porTabla[t].length)
  const fin = Math.max(...m.meta.estaciones.map((e) => pared(e.ultima_medicion)))
  const ini = fin - m.meta.reciente_horas * 3600
  $('reciente-sub').textContent = `Del ${fecha(ini)} al ${fecha(fin)} (las 72 h anteriores a la medición más reciente de la red), cada 5 minutos y sin los valores marcados.`
  vaciarConjunto('reciente')
  const avisos = tablas.filter((t) => !porTabla[t].length).map((t) => `${nombreEst(t)} no tiene mediciones en este periodo.`)
  for (const v of ['temperatura', 'humedad', 'radiacion_solar', 'lluvia_intensidad']) {
    const series = presentes.map((t) => ({ x: porTabla[t].map((f) => pared(f.tiempo)), y: porTabla[t].map((f) => num(f[v])) }))
    const { x, ys } = unir(series, 300)
    const con = presentes.filter((t) => correcciones(t, v, ini, fin).length)
    if (con.length) avisos.push(`${m.porVariable[v].nombre}: ${con.map(nombreEst).join(' y ')} ${con.length > 1 ? 'tienen' : 'tiene'} una corrección no documentada; compare con precaución.`)
    grafico('reciente', $(`r-${v}`), () => ({
      ...opcionesTiempo({ alto: 170, sync: 'reciente' }),
      series: [{ label: 'Hora', value: (u, s) => (s == null ? '–' : fecha(s)) }, ...presentes.map((t) => serieEstacion(t, v))],
      scales: { x: { time: true }, y: v === 'humedad' ? { range: [0, 100] } : v === 'temperatura' ? {} : { range: (u, a, b) => [0, b > 0 ? b * 1.08 : 1] } },
    }), [x, ...ys])
  }
  fijarRango('reciente', ini, fin)
  $('reciente-avisos').innerHTML = avisos.map((a) => `<li class="aviso-precaucion"><span class="m-aviso-icono">▲</span> ${escapar(a)}</li>`).join('')
}

// ───────────────────────── Explorador ─────────────────────────
function prepararConsulta() {
  const est = m.meta.estaciones
  $('q-estaciones').innerHTML = est
    .map((e, i) => `<label><input type="checkbox" value="${escapar(e.tabla)}"${i === 0 ? ' checked' : ''}>${punto(e.tabla)}${escapar(e.nombre)}</label>`)
    .join('')
  const categorias = new Map()
  for (const v of m.meta.variables) {
    if (!categorias.has(v.categoria)) categorias.set(v.categoria, [])
    categorias.get(v.categoria).push(v)
  }
  $('q-variables').innerHTML = [...categorias]
    .map(([cat, vs]) => `<div class="m-grupo"><span class="m-grupo-nombre">${escapar(cat)}</span>${vs
      .map((v) => `<label title="${escapar(v.tipo)} · se agrega con: ${AGREGACION[v.agregacion]}"><input type="checkbox" value="${v.variable}"${v.variable === 'temperatura' ? ' checked' : ''}> ${escapar(v.nombre)}${v.unidad ? ` <span class="suave">${escapar(v.unidad)}</span>` : ''}</label>`)
      .join('')}</div>`)
    .join('')
  const horas = (fin) => Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:${fin}</option>`).join('')
  $('q-h0').innerHTML = horas('00')
  $('q-h1').innerHTML = horas('59')
  $('q-h1').value = '23'
  const fin = Math.max(...est.map((e) => pared(e.ultima_medicion)))
  $('q-hasta').value = fechaISO(fin)
  $('q-desde').value = fechaISO(fin - 6 * D)
  const min = fechaISO(Math.min(...est.map((e) => pared(e.primer_registro))))
  const max = fechaISO(Math.max(...est.map((e) => pared(e.ultimo_registro))))
  for (const id of ['q-desde', 'q-hasta']) Object.assign($(id), { min, max })
  actualizarAyuda()
}

const estacionesElegidas = () => [...document.querySelectorAll('#q-estaciones input:checked')].map((c) => c.value)
const variablesElegidas = () => [...document.querySelectorAll('#q-variables input:checked')].map((c) => c.value)

$('q-atajos').addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (!b) return
  const elegidas = m.meta.estaciones.filter((e) => estacionesElegidas().includes(e.tabla))
  const lista = elegidas.length ? elegidas : m.meta.estaciones
  const fin = Math.max(...lista.map((e) => pared(e.ultima_medicion)))
  $('q-hasta').value = fechaISO(fin)
  $('q-desde').value = b.dataset.dias === 'todo'
    ? fechaISO(Math.min(...lista.map((e) => pared(e.primer_registro))))
    : fechaISO(fin - (Number(b.dataset.dias) - 1) * D)
  actualizarAyuda()
})

function rangoConsulta() {
  const desde = pared($('q-desde').value)
  const hasta = pared($('q-hasta').value) + D // la fecha final se incluye entera
  return { desde, hasta, dias: Math.round((hasta - desde) / D) }
}

function resolucionEfectiva() {
  const { dias } = rangoConsulta()
  const r = $('q-resolucion').value
  if (r !== 'auto') return r === '5min' && dias > MAX_DIAS_5MIN ? 'hora' : r
  return dias <= 7 ? '5min' : dias <= 120 ? 'hora' : 'dia'
}

function actualizarAyuda() {
  const { dias } = rangoConsulta()
  if (!(dias > 0)) {
    $('q-ayuda').textContent = 'La fecha final debe ser igual o posterior a la inicial.'
    return
  }
  const r = resolucionEfectiva()
  let texto = `${dias} día(s), ${{ '5min': 'cada registro (5 min)', hora: 'agregado por hora', dia: 'agregado por día' }[r]}.`
  if (r !== '5min') texto += ' Cada variable se agrega según su tipo: media, máximo, media circular (dirección del viento) o último valor del periodo (acumulados de lluvia).'
  if ($('q-resolucion').value === '5min' && dias > MAX_DIAS_5MIN) texto += ` Con más de ${MAX_DIAS_5MIN} días no se ofrecen registros de 5 min.`
  if (r === 'dia') texto += ' El filtro de horas no se aplica a los valores diarios.'
  $('q-ayuda').textContent = texto
}
for (const id of ['q-desde', 'q-hasta', 'q-resolucion']) $(id).addEventListener('change', actualizarAyuda)

function cargar(url) {
  if (!m.cache.has(url)) {
    m.cache.set(url, leerCSV(`${url}?v=${encodeURIComponent(m.meta.generado)}`).catch((err) => {
      m.cache.delete(url)
      throw err
    }))
  }
  return m.cache.get(url)
}

/** Filas de una estación para la consulta: [{ t, tiempo, id | n+ids, marcas, registro, f }] */
async function datosEstacion(e, res, desde, hasta, incluir, unaEstacion) {
  if (res === '5min') {
    const meses = e.meses.filter((mes) => {
      const [a, mm] = mes.split('-').map(Number)
      const ini = Date.UTC(a, mm - 1, 1) / 1000
      return ini < hasta && Date.UTC(a, mm, 1) / 1000 > desde
    })
    const partes = await Promise.all(meses.map((mes) => cargar(`${BASE}/5min/${e.tabla}/${mes}.csv`)))
    const filas = []
    for (const f of partes.flat()) {
      const t = pared(f.tiempo)
      if (t < desde || t >= hasta) continue
      const marcas = f.marcas || ''
      const registro = marcas.startsWith('*:') ? marcas.slice(2) : ''
      if (registro === 'dup') continue // hora repetida: queda en el CSV de 5 min, no en la consulta
      if (registro === 'pru' && !(incluir && unaEstacion)) continue // el periodo de prueba nunca se compara
      if (registro && !incluir) continue
      filas.push({ t, tiempo: f.tiempo, id: f.id, marcas, registro, f })
    }
    return filas
  }
  const filas = await cargar(`${BASE}/${res}/${e.tabla}${incluir ? '_todos' : ''}.csv`)
  return filas
    .map((f) => ({ t: pared(f[res]), tiempo: f[res], n: f.n, ids: `${f.id_min}–${f.id_max}`, marcas: '', registro: '', f }))
    .filter((r) => r.t >= desde && r.t < hasta)
}

/** En 5 min sin "incluir", un valor marcado de una variable se oculta (los demás del registro se ven). */
function valor(r, v, incluir) {
  if (!incluir && r.marcas && marcado(r, v)) return null
  return num(r.f[v])
}
function marcado(r, v) {
  if (r.registro) return true
  return !!r.marcas && r.marcas.split(' ').some((p) => p.startsWith(base(v) + ':'))
}

function avisosConsulta({ tablas, variables, res, desde, hasta, incluir, datos, filtroHoras, h0, h1 }) {
  const avisos = []
  for (const t of tablas) {
    const e = estacion(t)
    const s = estadoEstacion(e)
    if (s.h >= ACTIVA_H && pared(e.ultima_medicion) < hasta) {
      avisos.push({ tipo: 'alerta', texto: `${e.nombre}: sin mediciones desde el ${fecha(pared(e.ultima_medicion))} (${antiguedad(real(e.ultima_medicion))}).${s.repite ? ' Después solo envía el mismo registro repetido.' : ''}` })
    }
  }
  datos.forEach((filas, i) => {
    if (!filas.length) avisos.push({ tipo: 'alerta', texto: `${nombreEst(tablas[i])}: no hay datos en el periodo elegido.` })
  })
  for (const v of variables) {
    const con = tablas.filter((t) => correcciones(t, v, desde, hasta).length)
    if (!con.length) continue
    const exactitud = m.porVariable[v].exactitud ? ` Exactitud del sensor: ${m.porVariable[v].exactitud}.` : ''
    avisos.push({ tipo: 'precaucion', texto: `${m.porVariable[v].nombre}: ${con.map(nombreEst).join(', ')} ${con.length > 1 ? 'tienen' : 'tiene'} una corrección no documentada en este periodo.${tablas.length > 1 ? ' Compare entre estaciones con precaución.' : ''}${exactitud}` })
  }
  if (tablas.length > 1 && variables.includes('presion')) {
    avisos.push({ tipo: 'precaucion', texto: 'Presión: es la presión absoluta de cada estación, medida por el sensor interior de la consola, y depende de la altitud (≈ 728 hPa en el OAQ, 746 en Carapungo, 752 en Sangolquí). La diferencia entre estaciones no tiene un sentido físico directo.' })
  }
  const prueba = m.meta.eventos.find((ev) => ev.tipo === 'periodo_prueba')
  if (prueba && tablas.includes(prueba.tabla) && pared(prueba.inicio) < hasta && pared(prueba.fin) > desde) {
    const visible = tablas.length === 1 && incluir && res === '5min'
    avisos.push({ tipo: 'info', texto: `${nombreEst(prueba.tabla)}: el periodo de prueba (${fecha(pared(prueba.inicio))} a ${fecha(pared(prueba.fin))}) ${visible ? 'se muestra resaltado' : 'no entra en la consulta'}.` })
  }
  if (variables.some((v) => m.porVariable[v].agregacion === 'ultimo')) {
    avisos.push({ tipo: 'info', texto: 'Los acumulados de lluvia se reinician al empezar un nuevo evento, día, semana, mes o año. Se muestra el valor acumulado (el último del periodo al agregar), nunca una suma de acumulados.' })
  }
  if (res === '5min') {
    const marcadas = datos.reduce((s, filas) => s + filas.filter((r) => r.marcas && variables.some((v) => marcado(r, v))).length, 0)
    if (marcadas) {
      avisos.push({ tipo: 'precaucion', texto: incluir
        ? `${marcadas.toLocaleString('es')} valores con marca de calidad se muestran con un círculo rojo.`
        : `${marcadas.toLocaleString('es')} valores con marca de calidad quedan fuera. Elija "Incluir y resaltar" para verlos.` })
    }
  } else if (incluir) {
    avisos.push({ tipo: 'precaucion', texto: 'Los agregados incluyen los valores marcados (salvo el periodo de prueba y las horas repetidas).' })
  }
  if (filtroHoras) avisos.push({ tipo: 'info', texto: `Solo se muestran las horas de ${String(h0).padStart(2, '0')}:00 a ${String(h1).padStart(2, '0')}:59.` })
  return avisos
}

async function consultar() {
  const tablas = estacionesElegidas()
  const variables = variablesElegidas()
  if (!tablas.length || !variables.length) {
    $('q-ayuda').textContent = 'Elija al menos una estación y una variable.'
    return
  }
  const { desde, hasta, dias } = rangoConsulta()
  if (!(dias > 0)) return actualizarAyuda()
  const res = resolucionEfectiva()
  const incluir = $('q-marcados').value === 'incluir'
  const h0 = Number($('q-h0').value)
  const h1 = Number($('q-h1').value)
  const filtroHoras = res !== 'dia' && !(h0 === 0 && h1 === 23)
  const enHoras = (t) => {
    const h = new Date(t * 1000).getUTCHours()
    return h0 <= h1 ? h >= h0 && h <= h1 : h >= h0 || h <= h1
  }
  $('r-cargando').hidden = false
  let datos
  try {
    datos = await Promise.all(tablas.map((t) => datosEstacion(estacion(t), res, desde, hasta, incluir, tablas.length === 1)))
  } catch (err) {
    $('r-cargando').hidden = true
    $('m-error').hidden = false
    $('m-error').textContent = `No se pudieron leer los datos (${err.message}). Ejecute npm run meteorologia.`
    return
  }
  $('r-cargando').hidden = true
  $('m-error').hidden = true
  if (filtroHoras) datos = datos.map((filas) => filas.filter((r) => enHoras(r.t)))
  const q = { tablas, variables, res, desde, hasta, incluir, datos, h0, h1, filtroHoras }
  ultimaConsulta = q

  $('r-avisos').innerHTML = avisosConsulta(q)
    .map((a) => `<li class="aviso-${a.tipo}">${a.tipo === 'info' ? '<span class="m-info-icono">i</span>' : '<span class="m-aviso-icono">▲</span>'} ${escapar(a.texto)}</li>`)
    .join('')

  // ── Gráficos: uno por variable, una línea por estación ──
  const paso = { '5min': 300, hora: 3600, dia: D }[res]
  vaciarConjunto('explorador')
  $('r-graficos').innerHTML = ''
  const graficas = []
  for (const v of variables) {
    const a = m.porVariable[v].agregacion
    if (v === 'temperatura' && res === 'dia') {
      graficas.push({ c: 'temperatura', titulo: 'Temperatura del aire: media del día (°C)' })
      graficas.push({ c: 'temperatura_min', titulo: 'Temperatura mínima del día (°C)' })
      graficas.push({ c: 'temperatura_max', titulo: 'Temperatura máxima del día (°C)' })
    } else {
      graficas.push({ c: v, titulo: conUnidad(v) + (res === '5min' ? '' : ` · ${AGREGACION[a]} por ${res === 'hora' ? 'hora' : 'día'}`) })
    }
  }
  const fin = res === 'dia' ? hasta - D : hasta
  for (const gr of graficas) {
    const v = base(gr.c)
    const fig = document.createElement('figure')
    fig.innerHTML = `<figcaption>${escapar(gr.titulo)}</figcaption><div class="grafico"></div>`
    $('r-graficos').append(fig)
    const series = datos.map((filas) => ({ x: filas.map((r) => r.t), y: filas.map((r) => valor(r, gr.c, incluir)), filas }))
    const { x, ys, indice } = unir(series, paso)
    const resaltar = incluir && res === '5min'
      ? series.map((s) => s.filas.flatMap((r) => (marcado(r, v) ? [indice.get(r.t)] : [])))
      : null
    const marcadores = []
    for (const t of tablas) {
      for (const d of estacion(t).discontinuidades) {
        const tt = pared(d.tiempo)
        if (tt <= desde || tt >= hasta || !d.variables.includes(v)) continue
        const previo = marcadores.find((mk) => mk.t === tt && mk.tabla === t)
        if (previo) previo.texto += `; ${d.texto.toLowerCase()}`
        else marcadores.push({ t: tt, tabla: t, corto: nombreEst(t), texto: `${nombreEst(t)}: ${d.texto}` })
      }
    }
    const acumulado = m.porVariable[v].agregacion === 'ultimo'
    const opciones = {
      barras: tablas.length === 1 && ((v === 'lluvia_diaria' && res === 'dia') || v === 'lluvia_intensidad'),
      pasos: acumulado && res !== 'dia',
      puntos: v === 'direccion_viento',
    }
    const ejeY = v === 'direccion_viento'
      ? eje({ size: 52, splits: () => [0, 90, 180, 270, 360], values: (u, vals) => vals.map((g) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'O', 360: 'N' })[g]) })
      : eje({ size: 52 })
    grafico('explorador', fig.querySelector('.grafico'), () => ({
      ...opcionesTiempo({ alto: 210, sync: 'explorador', marcadores, resaltar }),
      series: [
        { label: res === 'dia' ? 'Día' : 'Hora', value: (u, s) => (s == null ? '–' : fecha(s, { hora: res !== 'dia' })) },
        ...tablas.map((t) => serieEstacion(t, gr.c, opciones)),
      ],
      scales: {
        x: { time: true },
        y: v === 'humedad' ? { range: (u, a, b) => [0, Math.max(100, b)] }
          : v === 'direccion_viento' ? { range: [0, 360] }
            : DESDE_CERO.includes(v) ? { range: (u, a, b) => [0, b > 0 ? b * 1.08 : 1] } : {},
      },
      axes: [eje({ size: 48, values: MARCAS_TIEMPO }), ejeY],
    }), [x, ...ys])
    if (marcadores.length) {
      const nota = document.createElement('p')
      nota.className = 'nota'
      nota.textContent = 'Discontinuidad: ' + marcadores.map((mk) => `${fecha(mk.t)}, ${mk.texto}`).join(' · ')
      fig.append(nota)
    }
  }
  if (variables.includes('direccion_viento')) {
    const nota = document.createElement('p')
    nota.className = 'nota m-nota-ancha'
    nota.textContent = 'Dirección del viento: de dónde sopla, en grados desde el norte. Los promedios son medias circulares (350° y 10° dan 0°, no 180°).'
    $('r-graficos').append(nota)
  }
  fijarRango('explorador', desde, fin)

  renderTabla()
  const total = datos.reduce((s, f) => s + f.length, 0)
  $('r-titulo').textContent = tablas.map(nombreEst).join(', ')
  $('r-resumen').textContent = `${fecha(desde, { hora: false })} – ${fecha(hasta - D, { hora: false })} · ${{ '5min': 'registros de 5 min', hora: 'por hora', dia: 'por día' }[res]} · ${total.toLocaleString('es')} filas`
  $('resultado').hidden = false
  requestAnimationFrame(() => {
    for (const g of conjuntos.get('explorador')) g.u?.setSize({ width: Math.max(220, g.el.clientWidth), height: g.u.height })
  })
}

$('consulta').addEventListener('submit', (ev) => {
  ev.preventDefault()
  consultar()
})

// ── Tabla y descarga ──
function columnasTabla(q) {
  return q.variables.flatMap((v) => (v === 'temperatura' && q.res === 'dia' ? ['temperatura', 'temperatura_min', 'temperatura_max'] : [v]))
}
function tituloColumna(c) {
  if (c === 'temperatura_min') return 'Temperatura mínima (°C)'
  if (c === 'temperatura_max') return 'Temperatura máxima (°C)'
  return conUnidad(c)
}
function filasTabla(q) {
  const filas = []
  q.datos.forEach((lista, i) => lista.forEach((r) => filas.push({ tabla: q.tablas[i], ...r })))
  return filas.sort((a, b) => b.t - a.t || a.tabla.localeCompare(b.tabla))
}
function textoMarcas(marcas) {
  if (!marcas) return ''
  return marcas.split(' ').map((p) => {
    const [v, c] = p.split(':')
    return `${v === '*' ? 'registro' : (m.porVariable[v]?.nombre ?? v).toLowerCase()}: ${m.meta.marcas[c] ?? c}`
  }).join('; ')
}

function renderTabla() {
  const q = ultimaConsulta
  const cols = columnasTabla(q)
  const filas = filasTabla(q)
  const traza = q.res === '5min' ? '<th>id</th>' : '<th>Registros</th><th>id</th>'
  const cab = `<thead><tr><th>Estación</th><th>${{ '5min': 'Tiempo', hora: 'Hora', dia: 'Día' }[q.res]}</th>${traza}${cols.map((c) => `<th>${escapar(tituloColumna(c))}</th>`).join('')}<th>Marcas</th></tr></thead>`
  const cuerpo = filas.slice(0, MAX_FILAS).map((r) => {
    const trazaCeldas = q.res === '5min' ? `<td>${escapar(r.id)}</td>` : `<td>${escapar(r.n)}</td><td>${escapar(r.ids)}</td>`
    const celdas = cols.map((c) => `<td${r.marcas && marcado(r, c) ? ' class="valor-marcado"' : ''}>${fmt(num(r.f[c]), dec(c))}</td>`).join('')
    return `<tr><td>${escapar(nombreEst(r.tabla))}</td><td>${escapar(r.tiempo)}</td>${trazaCeldas}${celdas}<td class="m-marcas-celda">${escapar(textoMarcas(r.marcas))}</td></tr>`
  }).join('')
  $('r-tabla').innerHTML = cab + `<tbody>${cuerpo || `<tr><td colspan="${cols.length + 5}">Sin datos en el periodo elegido.</td></tr>`}</tbody>`
  const origen = q.res === '5min' ? 'el id de cada registro' : 'el número de registros y el rango de ids agregados'
  $('r-tabla-nota').textContent = filas.length > MAX_FILAS
    ? `Se muestran las ${MAX_FILAS} filas más recientes de ${filas.length.toLocaleString('es')}. El CSV las contiene todas, con la tabla de origen, ${origen} y las marcas de calidad.`
    : `${filas.length.toLocaleString('es')} filas. El CSV incluye la tabla de origen, ${origen} y las marcas de calidad.`
}

$('r-descargar').addEventListener('click', () => {
  const q = ultimaConsulta
  if (!q) return
  const cols = columnasTabla(q)
  const campo = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const cab = ['estacion', 'tabla', { '5min': 'tiempo_local', hora: 'hora_local', dia: 'dia' }[q.res],
    ...(q.res === '5min' ? ['id'] : ['n_registros', 'id_min', 'id_max']),
    ...cols.map((c) => (unidad(c) ? `${c} (${unidad(c)})` : c)), 'marcas']
  const lineas = [cab.join(',')]
  for (const r of filasTabla(q).reverse()) {
    const traza = q.res === '5min' ? [r.id] : [r.n, r.f.id_min, r.f.id_max]
    lineas.push([nombreEst(r.tabla), r.tabla, r.tiempo, ...traza, ...cols.map((c) => r.f[c] ?? ''), textoMarcas(r.marcas)]
      .map((x) => campo(String(x ?? ''))).join(','))
  }
  const blob = new Blob(['﻿' + lineas.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `meteo_oaq_${q.res}_${q.incluir ? 'con_marcados_' : ''}${fechaISO(q.desde)}_${fechaISO(q.hasta - D)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

// ───────────────────────── Calidad y eventos ─────────────────────────
function renderCalidad() {
  const est = m.meta.estaciones
  const n = (x) => (x || 0).toLocaleString('es')
  const suma = (q, clave) => Object.values(q.por_variable).reduce((s, c) => s + (c[clave] || 0), 0)
  const detalle = (q, clave) => {
    const t = Object.entries(q.por_variable).filter(([, c]) => c[clave]).map(([v, c]) => `${m.porVariable[v]?.nombre.toLowerCase() ?? v}: ${n(c[clave])}`).join(', ')
    return t ? ` <span class="suave">(${escapar(t)})</span>` : ''
  }
  const filas = [
    ['Registros', (e) => n(e.calidad.registros)],
    ['Primer registro', (e) => fecha(pared(e.primer_registro))],
    ['Último registro recibido', (e) => fecha(pared(e.ultimo_registro))],
    ['Última medición válida', (e) => fecha(pared(e.ultima_medicion))],
    ['Intervalo típico', (e) => `${fmt(e.calidad.intervalo_min, 1)} min`],
    ['Cobertura', (e) => `${fmt(e.calidad.cobertura_pct, 1)} %`],
    ['Huecos de más de 1 h', (e) => `${n(e.calidad.huecos)}${e.calidad.huecos ? ` <span class="suave">(el mayor, ${fmt(e.calidad.mayor_hueco_h / 24, 1)} días)</span>` : ''}`],
    ['Horas repetidas', (e) => n(e.calidad.por_marca_registro.dup)],
    ['Registros repetidos sin cambios', (e) => n(e.calidad.por_marca_registro.rep)],
    ['Periodo de prueba', (e) => n(e.calidad.por_marca_registro.pru)],
    ['Fuera de especificación', (e) => n(suma(e.calidad, 'esp')) + detalle(e.calidad, 'esp')],
    ['Fuera de especificación por la corrección', (e) => n(suma(e.calidad, 'cor')) + detalle(e.calidad, 'cor')],
    ['Sospechosos', (e) => n(suma(e.calidad, 'sos')) + detalle(e.calidad, 'sos')],
    ['Valores vacíos', (e) => n(suma(e.calidad, 'nulos')) + detalle(e.calidad, 'nulos')],
  ]
  $('cal-tabla').innerHTML = `<thead><tr><th></th>${est.map((e) => `<th scope="col">${punto(e.tabla)}${escapar(e.nombre)}</th>`).join('')}</tr></thead>
    <tbody>${filas.map(([t, f]) => `<tr><th scope="row">${t}</th>${est.map((e) => `<td>${f(e)}</td>`).join('')}</tr>`).join('')}</tbody>`
  $('cal-marcas').innerHTML = Object.entries({
    'Fuera de especificación': 'Fuera del rango que garantiza el fabricante: UV mayor que 15, humedad mayor que 99 % o radiación por encima de la saturación (2367,8 W/m²).',
    'Fuera por la corrección': 'Fuera de especificación solo por efecto de la corrección no documentada del servidor (p. ej. humedad 99 % → 99,38 %). No es un fallo del sensor.',
    Sospechoso: 'Fuera del rango plausible: temperatura fuera de −10 a 40 °C o presión a más de 30 hPa de la mediana de la estación. Rangos provisionales, a validar por el OAQ.',
    'Registro repetido': 'Una hora o más con exactamente el mismo registro en las 14 variables: el registrador no está midiendo.',
    'Periodo de prueba': 'Carapungo antes de su instalación. No entra en comparaciones ni estadísticas.',
  }).map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('')
  $('cal-generado').textContent = `procesado ${antiguedad(Date.parse(m.meta.generado))}`

  $('cal-obs').innerHTML = est.map((e) => {
    const huecos = e.calidad.lista_huecos.filter((h) => h.horas >= 24)
    const items = e.notas.map((t) => `<li>${escapar(t)}</li>`)
    if (huecos.length) {
      items.push(`<li>Huecos de un día o más: ${huecos.map((h) => `${escapar(fecha(pared(h.desde), { hora: false }))} → ${escapar(fecha(pared(h.hasta), { hora: false }))} (${fmt(h.horas / 24, 0)} d)`).join('; ')}.</li>`)
    }
    return `<article class="panel"><h3>${punto(e.tabla)}${escapar(e.nombre)} <span class="suave">· tabla ${escapar(e.tabla)} · ${escapar(e.equipo)}</span></h3>
      <ul>${items.join('') || '<li>Sin observaciones.</li>'}</ul></article>`
  }).join('')

  const tipo = { periodo_prueba: 'Periodo de prueba', correccion_no_documentada: 'Corrección no documentada' }
  $('cal-eventos').innerHTML = `<thead><tr><th>Estación</th><th>Tipo</th><th>Desde</th><th>Hasta</th><th>Variables</th><th>Efecto</th><th>Descripción</th></tr></thead>
    <tbody>${m.meta.eventos.map((ev) => `<tr>
      <td>${punto(ev.tabla)}${escapar(nombreEst(ev.tabla))}</td><td>${escapar(tipo[ev.tipo] ?? ev.tipo)}</td>
      <td>${ev.inicio ? escapar(fecha(pared(ev.inicio))) : 'todo el registro'}</td><td>${ev.fin ? escapar(fecha(pared(ev.fin))) : 'vigente'}</td>
      <td>${ev.variables.length === m.meta.variables.length ? 'todas' : escapar(ev.variables.map((v) => m.porVariable[v].nombre.toLowerCase()).join(', '))}</td>
      <td>${ev.efecto === 'excluir_comparaciones' ? 'se excluye de comparaciones' : 'comparar con precaución'}</td>
      <td>${escapar(ev.descripcion)}</td></tr>`).join('')}</tbody>`

  $('cal-rangos').textContent = `${m.meta.zona_horaria}. Las estaciones ya guardan los datos en unidades de la OMM (el servidor convierte desde unidades imperiales), así que no se aplica ninguna conversión.`
  $('cal-variables').innerHTML = `<thead><tr><th>Variable</th><th>Columna en la base</th><th>Unidad</th><th>Tipo</th><th>Agregación</th><th>Exactitud</th></tr></thead>
    <tbody>${m.meta.variables.map((v) => `<tr><td>${escapar(v.nombre)}</td><td><code>${escapar(v.columna)}</code></td><td>${escapar(v.unidad || 'adimensional')}</td><td>${escapar(v.tipo)}</td><td>${AGREGACION[v.agregacion]}</td><td>${escapar(v.exactitud ?? '–')}</td></tr>`).join('')}</tbody>`
}

// ───────────────────────── Datos: archivos y carga ─────────────────────────
const d = { archivos: null, sesion: false, sondeo: null }

function tamano(bytes) {
  return bytes >= 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 1)} MB` : `${fmt(bytes / 1024, 0)} kB`
}

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, { cache: 'no-store', credentials: 'same-origin', ...opciones })
  let datos = {}
  try {
    datos = await r.json()
  } catch {
    // sin cuerpo
  }
  return { ok: r.ok, estado: r.status, datos }
}

async function renderDatos() {
  const { ok, datos } = await api('/api/meteo/archivos')
  if (!ok) {
    $('d-tabla').innerHTML = '<tbody><tr><td>No se pudo consultar el servidor.</td></tr></tbody>'
    return
  }
  d.archivos = datos
  const porTabla = Object.fromEntries((m.meta?.estaciones ?? []).map((e) => [e.tabla, e]))
  $('d-tabla').innerHTML = `<thead><tr><th>Archivo</th><th>Estación</th><th>Registros</th><th>Desde</th><th>Hasta</th><th>Tamaño</th><th>Modificado</th><th>Copias anteriores</th></tr></thead>
    <tbody>${datos.archivos.map((a) => {
      const e = porTabla[a.nombre.replace(/\.parquet$/, '')]
      const procesado = e && Math.abs(Date.parse(e.archivo_modificado) - a.mtime) < 2000
      return `<tr>
        <td><code>${escapar(a.nombre)}</code></td>
        <td>${e ? `${punto(e.tabla)}${escapar(e.nombre)}` : '<span class="suave">sin procesar</span>'}</td>
        <td>${e && procesado ? e.calidad.registros.toLocaleString('es') : '–'}</td>
        <td>${e && procesado ? escapar(fecha(pared(e.primer_registro))) : '–'}</td>
        <td>${e && procesado ? escapar(fecha(pared(e.ultimo_registro))) : '–'}</td>
        <td>${tamano(a.tam)}</td>
        <td>${escapar(new Date(a.mtime).toLocaleString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}${procesado || !e ? '' : ' <span class="chip next">por procesar</span>'}</td>
        <td>${a.copias.length ? a.copias.length : '0'}</td>
      </tr>`
    }).join('')}</tbody>`
  const chip = $('d-proceso')
  const u = datos.ultimo
  if (datos.procesando) {
    chip.className = 'chip curso'
    chip.textContent = 'procesando…'
  } else if (u && !u.ok) {
    chip.className = 'chip error'
    chip.textContent = 'el último procesamiento falló'
  } else {
    chip.className = 'chip ok'
    chip.textContent = 'datos al día'
  }
  $('d-ultimo').innerHTML = u
    ? `Último procesamiento automático: ${escapar(antiguedad(u.fin))} (${escapar(u.motivo)}), ${u.ok ? 'correcto' : `con error: ${escapar(u.error)}`}.${u.salida && !u.ok ? `<pre class="m-salida">${escapar(u.salida)}</pre>` : ''}`
    : 'Desde que arrancó el servidor no hubo cambios en los archivos.'
  return datos
}

/** Consulta cada 2 s mientras se procesa; al terminar, recarga todo lo que muestra la página. */
function seguirProceso() {
  clearInterval(d.sondeo)
  d.sondeo = setInterval(async () => {
    const datos = await renderDatos()
    if (datos && !datos.procesando) {
      clearInterval(d.sondeo)
      await revisarDatos()
      renderDatos()
    }
  }, 2000)
}

async function revisarSesion() {
  const { datos } = await api('/api/admin/sesion')
  d.sesion = !!datos.activa
  $('d-entrar').hidden = d.sesion
  $('d-carga').hidden = !d.sesion
  $('d-salir').hidden = !d.sesion
  if (!d.sesion && datos.configurada === false) {
    $('d-error-entrar').hidden = false
    $('d-error-entrar').textContent = 'El servidor aún no tiene contraseña. En el servidor: ./setup_sun.sh contrasena'
  }
}

$('d-entrar').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const r = await api('/api/admin/entrar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contrasena: $('d-contrasena').value }),
  })
  $('d-contrasena').value = ''
  $('d-error-entrar').hidden = r.ok
  if (!r.ok) $('d-error-entrar').textContent = r.datos.error || 'No se pudo entrar.'
  revisarSesion()
})
$('d-salir').addEventListener('click', async () => {
  await api('/api/admin/salir', { method: 'POST' })
  revisarSesion()
})

/** Sube un archivo con barra de progreso (XMLHttpRequest informa el avance; fetch no). */
function subir(archivo, nombre, alAvanzar) {
  return new Promise((resolver) => {
    const x = new XMLHttpRequest()
    x.open('POST', `/api/meteo/subir?nombre=${encodeURIComponent(nombre)}`)
    x.setRequestHeader('Content-Type', 'application/octet-stream')
    x.upload.onprogress = (e) => e.lengthComputable && alAvanzar(e.loaded / e.total)
    x.onload = () => {
      let datos = {}
      try {
        datos = JSON.parse(x.responseText)
      } catch {
        // sin cuerpo
      }
      resolver({ ok: x.status < 300, estado: x.status, datos })
    }
    x.onerror = () => resolver({ ok: false, estado: 0, datos: { error: 'Se cortó la conexión con el servidor.' } })
    x.send(archivo)
  })
}

function opcionesEstacion(nombreArchivo) {
  const tabla = nombreArchivo.replace(/\.parquet$/i, '').replace(/[^A-Za-z0-9_-]/g, '')
  const conocidas = (m.meta?.estaciones ?? []).map((e) => [e.tabla, e.nombre])
  const existe = conocidas.some(([t]) => t === tabla)
  const opciones = conocidas.map(([t, n]) => `<option value="${escapar(t)}"${t === tabla ? ' selected' : ''}>${escapar(n)} (${escapar(t)}.parquet)</option>`)
  if (!existe && tabla) opciones.unshift(`<option value="${escapar(tabla)}" selected>Estación nueva: ${escapar(tabla)}.parquet</option>`)
  if (!tabla && !conocidas.length) opciones.push('<option value="">–</option>')
  return opciones.join('')
}

function htmlValidacion(v) {
  const filas = []
  if (v.nuevo) {
    const r = (x) => `${x.registros.toLocaleString('es')} registros · ${fecha(pared(x.desde))} → ${fecha(pared(x.hasta))}`
    filas.push(`<div><dt>Archivo nuevo</dt><dd>${escapar(r(v.nuevo))}</dd></div>`)
    filas.push(`<div><dt>Archivo actual</dt><dd>${v.actual ? escapar(r(v.actual)) : 'no hay (estación nueva)'}</dd></div>`)
    filas.push(`<div><dt>Registros posteriores al actual</dt><dd><b>${(v.registros_nuevos ?? 0).toLocaleString('es')}</b></dd></div>`)
  }
  return `<dl class="m-validacion">${filas.join('')}</dl>
    <ul class="m-avisos">${v.errores.map((e) => `<li class="aviso-alerta"><span class="m-aviso-icono">▲</span> ${escapar(e)}</li>`).join('')}${v.avisos
      .map((a) => `<li class="aviso-precaucion"><span class="m-aviso-icono">▲</span> ${escapar(a)}</li>`).join('')}</ul>`
}

function agregarArchivo(archivo) {
  const caja = document.createElement('article')
  caja.className = 'm-subida'
  caja.innerHTML = `<header class="panel-cab">
      <h3><code>${escapar(archivo.name)}</code> <span class="suave">${tamano(archivo.size)}</span></h3>
      <span class="chip todo">sin revisar</span>
    </header>
    <div class="m-fila m-elegir">
      <div class="campo"><label>Reemplaza a</label><select>${opcionesEstacion(archivo.name)}</select></div>
      <div class="botones"><button type="button" class="boton" data-accion="revisar">Revisar</button>
      <button type="button" class="boton-texto" data-accion="quitar">Quitar</button></div>
    </div>
    <div class="m-progreso" hidden><span></span></div>
    <div class="m-resultado-subida"></div>`
  $('d-subidas').prepend(caja)
  const chip = caja.querySelector('.chip')
  const progreso = caja.querySelector('.m-progreso')
  const resultado = caja.querySelector('.m-resultado-subida')
  const estado = (clase, texto) => {
    chip.className = `chip ${clase}`
    chip.textContent = texto
  }
  let id = null

  caja.addEventListener('click', async (ev) => {
    const accion = ev.target.closest('button')?.dataset.accion
    if (!accion) return
    if (accion === 'quitar') {
      if (id) await api('/api/meteo/descartar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      caja.remove()
      return
    }
    if (accion === 'revisar') {
      const tabla = caja.querySelector('select').value
      if (!tabla) return
      caja.querySelectorAll('button, select').forEach((b) => (b.disabled = true))
      progreso.hidden = false
      estado('curso', 'subiendo…')
      const r = await subir(archivo, `${tabla}.parquet`, (f) => {
        progreso.firstElementChild.style.width = `${Math.round(f * 100)}%`
        if (f >= 1) estado('curso', 'revisando…')
      })
      progreso.hidden = true
      caja.querySelector('.m-elegir').hidden = r.estado !== 401
      if (r.estado === 401) {
        estado('error', 'sesión vencida')
        resultado.innerHTML = '<p class="m-alerta">La sesión venció. Entre de nuevo y vuelva a intentarlo.</p>'
        revisarSesion()
        caja.querySelectorAll('button, select').forEach((b) => (b.disabled = false))
        return
      }
      if (!r.ok) {
        estado('error', 'no válido')
        resultado.innerHTML = (r.datos.validacion ? htmlValidacion(r.datos.validacion) : `<p class="m-alerta">${escapar(r.datos.error || 'Error al subir.')}</p>`)
          + '<div class="botones"><button type="button" class="boton-texto" data-accion="quitar">Quitar</button></div>'
        return
      }
      id = r.datos.id
      const v = r.datos.validacion
      estado(v.avisos.length ? 'next' : 'ok', v.avisos.length ? 'revisado, con avisos' : 'revisado')
      resultado.innerHTML = htmlValidacion(v) + `<div class="botones">
        <button type="button" class="boton" data-accion="confirmar">Reemplazar ${escapar(v.archivo)}</button>
        <button type="button" class="boton-texto" data-accion="quitar">Descartar</button></div>`
      return
    }
    if (accion === 'confirmar') {
      resultado.querySelectorAll('button').forEach((b) => (b.disabled = true))
      const r = await api('/api/meteo/confirmar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      if (!r.ok) {
        estado('error', 'no se reemplazó')
        resultado.insertAdjacentHTML('beforeend', `<p class="m-alerta">${escapar(r.datos.error || 'Error.')}</p>`)
        return
      }
      id = null
      estado('ok', 'reemplazado')
      resultado.innerHTML = `<p>Listo. ${r.datos.copia ? `El archivo anterior quedó como copia (<code>.anteriores/${escapar(r.datos.copia)}</code>). ` : ''}Los datos se están procesando; la página se actualiza sola al terminar.</p>`
      renderDatos()
      setTimeout(seguirProceso, 500)
    }
  })
}

function recibirArchivos(lista) {
  for (const a of lista) {
    if (!/\.parquet$/i.test(a.name)) continue
    agregarArchivo(a)
  }
}
$('d-archivo').addEventListener('change', (ev) => {
  recibirArchivos(ev.target.files)
  ev.target.value = ''
})
const zona = $('d-soltar')
zona.addEventListener('dragover', (ev) => {
  ev.preventDefault()
  zona.classList.add('encima')
})
zona.addEventListener('dragleave', () => zona.classList.remove('encima'))
zona.addEventListener('drop', (ev) => {
  ev.preventDefault()
  zona.classList.remove('encima')
  recibirArchivos(ev.dataTransfer.files)
})

// ───────────────────────── Carga ─────────────────────────
async function cargarMeta() {
  const r = await fetch(`${BASE}/estaciones.json`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`estaciones.json: ${r.status}`)
  return r.json()
}

function usarMeta(meta) {
  m.meta = meta
  m.porVariable = Object.fromEntries(meta.variables.map((v) => [v.variable, v]))
  meta.estaciones.forEach((e, i) => (m.color[e.tabla] = COLORES[i % COLORES.length]))
}

function renderTodo() {
  renderRed()
  renderTarjetas()
  renderCalidad()
  renderReciente()
}

/** Si los datos se volvieron a procesar, recarga todo; si no, solo recalcula las antigüedades. */
async function revisarDatos() {
  let nueva
  try {
    nueva = await cargarMeta()
  } catch {
    return // sin servidor o sin datos: se mantiene lo que se ve
  }
  const primera = !m.meta
  if (primera || nueva.generado !== m.meta.generado) {
    usarMeta(nueva)
    m.cache.clear()
    $('m-error').hidden = true
    if (primera) prepararConsulta()
    renderTodo()
    if (ultimaConsulta) consultar()
    return
  }
  renderRed()
  renderTarjetas()
}

async function iniciar() {
  revisarSesion()
  try {
    usarMeta(await cargarMeta())
  } catch {
    $('m-error').hidden = false
    $('m-error').innerHTML = 'Aún no hay datos meteorológicos procesados. Cárguelos en la sección <a href="#datos">Datos</a> o ejecute <code>npm run meteorologia</code> en el servidor.'
    mostrarSeccion('datos')
    renderDatos()
    return
  }
  prepararConsulta()
  renderTodo()
  renderDatos()
  mostrarSeccion(location.hash.slice(1) || 'panel')
}

// Cada minuto: se recalcula la antigüedad y se revisa si los datos cambiaron (por ejemplo, porque
// alguien copió un Parquet nuevo al servidor).
setInterval(async () => {
  const datos = await renderDatos()
  if (datos?.procesando) return seguirProceso()
  revisarDatos()
}, 60000)

alCambiarTema(() => {
  for (const lista of conjuntos.values()) for (const g of lista) g.crear()
})

iniciar()
