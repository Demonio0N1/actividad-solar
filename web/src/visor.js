// Visores de resultados de los modelos, usados por la página pública (resultado publicado)
// y por el laboratorio (corrida en vivo).
//   crearVisorLatitud(contenedor)  diagrama mariposa B(λ, t) + actividad ⟨B²⟩ + perfil B(λ)
//   crearVisorSerie(contenedor)    número de manchas del modelo frente al observado (SILSO)
import { escapar, token } from './comun.js'
import {
  ajustarCanvas, colocarTooltip, eje, FUENTE_EJES, leerCSV, num, numero, registrarGrafico, rgb,
} from './graficos.js'

const MARGEN = { l: 42, r: 10, t: 8, b: 34 }

function construirLUT() {
  const paradas = ['--div-1', '--div-2', '--div-0', '--div-3', '--div-4'].map((v) => rgb(token(v)))
  const tabla = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (paradas.length - 1)
    const k = Math.min(Math.floor(x), paradas.length - 2)
    const f = x - k
    for (let c = 0; c < 3; c++) tabla[i * 3 + c] = paradas[k][c] * (1 - f) + paradas[k + 1][c] * f
  }
  return tabla
}

export function crearVisorLatitud(contenedor, { vacio = 'Sin datos todavía.' } = {}) {
  contenedor.classList.add('visor')
  contenedor.innerHTML = `
    <div class="mapa">
      <canvas aria-label="Diagrama mariposa simulado: campo toroidal B según latitud y tiempo"></canvas>
      <div class="tooltip" hidden></div>
      <div class="vacio"><p>${vacio}</p></div>
    </div>
    <div class="leyenda-div" aria-hidden="true">
      <span>B negativo</span><span class="barra-div"></span><span>B positivo</span>
      <span class="suave">· la escala se ajusta al máximo |B|</span>
    </div>
    <div class="mini-graficos">
      <figure><figcaption>Actividad simulada ⟨B²⟩ en |λ| &lt; 40° <span class="suave">(análogo al número de manchas)</span></figcaption><div class="grafico g-actividad"></div></figure>
      <figure><figcaption>Perfil del campo toroidal B(λ) en el último instante</figcaption><div class="grafico g-perfil"></div></figure>
    </div>`
  const canvas = contenedor.querySelector('canvas')
  const tip = contenedor.querySelector('.tooltip')
  const elVacio = contenedor.querySelector('.vacio')

  const d = { config: null, tiempos: [], cuadros: [], actividad: [], vmax: 0, enCurso: false, aniosPorUnidad: null }
  const lienzo = { canvas: null, ctx: null, img: null, pintados: 0, vmaxPintado: 0 }
  let lut = construirLUT()
  let pendiente = false

  const gActividad = registrarGrafico(contenedor.querySelector('.g-actividad'), () => ({
    height: 150,
    legend: { show: false },
    cursor: { points: { size: 7 } },
    scales: { x: { time: false, range: () => [0, d.config?.t_max ?? 8] } },
    axes: [eje({ size: 28 }), eje({ size: 44, values: (u, v) => v.map((x) => numero(x)) })],
    series: [{ label: 't' }, { label: '⟨B²⟩', stroke: token('--serie-2'), width: 2, points: { show: false } }],
  }), [[], []])
  const gPerfil = registrarGrafico(contenedor.querySelector('.g-perfil'), () => ({
    height: 150,
    legend: { show: false },
    scales: {
      x: { time: false, range: [-90, 90] },
      y: { range: () => { const v = d.vmax || 1; return [-v * 1.05, v * 1.05] } },
    },
    axes: [
      eje({ size: 28, values: (u, v) => v.map((x) => `${x}°`), incrs: [30, 45, 90] }),
      eje({ size: 44, space: 18, values: (u, v) => v.map((x) => numero(x)) }),
    ],
    series: [{ label: 'λ' }, { label: 'B', stroke: token('--serie-1'), width: 2, points: { show: false } }],
  }), [[], []])

  function actividadDe(B) {
    let suma = 0
    let n = 0
    for (let i = 0; i < B.length; i++) {
      if (Math.abs(d.config.lat[i]) < 40) {
        suma += B[i] * B[i]
        n++
      }
    }
    return n ? suma / n : 0
  }

  function pintar(todo = false) {
    const W = Math.max(2, d.config.cuadros || d.cuadros.length)
    const H = d.config.lat.length
    if (!lienzo.canvas || lienzo.canvas.width !== W || lienzo.canvas.height !== H) {
      lienzo.canvas = document.createElement('canvas')
      lienzo.canvas.width = W
      lienzo.canvas.height = H
      lienzo.ctx = lienzo.canvas.getContext('2d')
      lienzo.img = lienzo.ctx.createImageData(W, H)
      lienzo.pintados = 0
      lienzo.vmaxPintado = 0
    }
    // Mientras el campo crece, la escala de color se ajusta al máximo y se repinta todo
    const repintar = todo || lienzo.vmaxPintado === 0 || d.vmax > lienzo.vmaxPintado * 1.05
    if (repintar) {
      lienzo.img.data.fill(0)
      lienzo.vmaxPintado = d.vmax || 1
    }
    const escala = lienzo.vmaxPintado
    const datos = lienzo.img.data
    const col = (t) => Math.min(W - 1, Math.max(0, Math.round((t / d.config.t_max) * (W - 1))))
    const desde = repintar ? 0 : Math.max(0, lienzo.pintados - 1)
    for (let k = desde; k < d.cuadros.length; k++) {
      const x0 = col(d.tiempos[k])
      const x1 = k + 1 < d.cuadros.length ? Math.max(x0 + 1, col(d.tiempos[k + 1])) : x0 + 1
      const B = d.cuadros[k]
      for (let i = 0; i < H; i++) {
        const j = Math.max(0, Math.min(255, Math.round((B[i] / escala) * 127.5 + 127.5))) * 3
        for (let x = x0; x < Math.min(x1, W); x++) {
          const p = (i * W + x) * 4
          datos[p] = lut[j]
          datos[p + 1] = lut[j + 1]
          datos[p + 2] = lut[j + 2]
          datos[p + 3] = 255
        }
      }
    }
    lienzo.pintados = d.cuadros.length
    lienzo.ctx.putImageData(lienzo.img, 0, 0)
  }

  function dibujar() {
    const { ctx, w, h } = ajustarCanvas(canvas)
    const m = MARGEN
    const pw = w - m.l - m.r
    const ph = h - m.t - m.b
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = token('--code-bg')
    ctx.fillRect(m.l, m.t, pw, ph)
    if (!d.config) return
    if (lienzo.canvas) {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(lienzo.canvas, m.l, m.t, pw, ph)
    }
    ctx.font = FUENTE_EJES
    ctx.fillStyle = token('--ink-3')
    ctx.strokeStyle = token('--ink-3')
    ctx.lineWidth = 1
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const lat of [90, 60, 30, 0, -30, -60, -90]) {
      const y = m.t + ((90 - lat) / 180) * ph
      ctx.fillText(`${lat}°`, m.l - 6, y)
      ctx.beginPath()
      ctx.moveTo(m.l - 3, y)
      ctx.lineTo(m.l, y)
      ctx.stroke()
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const tmax = d.config.t_max
    const paso = tmax > 20 ? 5 : tmax > 10 ? 2 : 1
    for (let t = 0; t <= tmax + 1e-9; t += paso) {
      const x = m.l + (t / tmax) * pw
      ctx.fillText(String(t), x, m.t + ph + 5)
      ctx.beginPath()
      ctx.moveTo(x, m.t + ph)
      ctx.lineTo(x, m.t + ph + 3)
      ctx.stroke()
    }
    ctx.fillText('tiempo (unidades de difusión R²/η)', m.l + pw / 2, m.t + ph + 19)
    if (d.enCurso && d.tiempos.length) {
      const x = m.l + (d.tiempos.at(-1) / tmax) * pw
      ctx.strokeStyle = token('--ink')
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x + 0.5, m.t)
      ctx.lineTo(x + 0.5, m.t + ph)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  function render() {
    pendiente = false
    elVacio.hidden = !!(d.config && d.cuadros.length)
    if (!d.config) return dibujar()
    pintar()
    dibujar()
    gActividad.poner([d.tiempos, d.actividad])
    const ultimo = d.cuadros.at(-1)
    gPerfil.poner(ultimo ? [[...d.config.lat].reverse(), [...ultimo].reverse()] : [[], []])
  }
  function programar() {
    if (!pendiente) {
      pendiente = true
      requestAnimationFrame(render)
    }
  }

  canvas.addEventListener('mousemove', (ev) => {
    if (!d.config || !d.cuadros.length) return
    const r = canvas.getBoundingClientRect()
    const pw = r.width - MARGEN.l - MARGEN.r
    const ph = r.height - MARGEN.t - MARGEN.b
    const x = ev.clientX - r.left
    const y = ev.clientY - r.top
    const fx = (x - MARGEN.l) / pw
    const fy = (y - MARGEN.t) / ph
    const t = fx * d.config.t_max
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1 || t > d.tiempos.at(-1)) {
      tip.hidden = true
      return
    }
    // Cuadro más cercano en el tiempo (búsqueda binaria)
    let lo = 0
    let hi = d.tiempos.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (d.tiempos[mid] < t) lo = mid
      else hi = mid
    }
    const k = Math.abs(d.tiempos[hi] - t) < Math.abs(d.tiempos[lo] - t) ? hi : lo
    const i = Math.max(0, Math.min(d.config.lat.length - 1, Math.round(fy * (d.config.lat.length - 1))))
    const B = d.cuadros[k][i]
    const anios = d.aniosPorUnidad ? ` · ${(d.tiempos[k] * d.aniosPorUnidad).toFixed(1)} años` : ''
    colocarTooltip(tip, x, y, r.width,
      `t = <b>${d.tiempos[k].toFixed(3)}</b>${anios}<br>λ = <b>${d.config.lat[i].toFixed(1)}°</b><br>B = <b>${B >= 0 ? '+' : ''}${numero(B)}</b>`)
  })
  canvas.addEventListener('mouseleave', () => (tip.hidden = true))
  new ResizeObserver(() => programar()).observe(contenedor.querySelector('.mapa'))

  return {
    /** Empieza una corrida nueva (en vivo). */
    configurar(config) {
      Object.assign(d, { config, tiempos: [], cuadros: [], actividad: [], vmax: 0, enCurso: true, aniosPorUnidad: null })
      lienzo.canvas = null
      programar()
    },
    agregar(tiempo, B) {
      if (!d.config) return
      for (const b of B) if (Math.abs(b) > d.vmax) d.vmax = Math.abs(b)
      d.tiempos.push(tiempo)
      d.cuadros.push(B)
      d.actividad.push(actividadDe(B))
      programar()
    },
    terminar(resumen) {
      d.enCurso = false
      d.aniosPorUnidad = resumen?.anios_por_unidad ?? null
      programar()
    },
    /** Muestra una corrida completa ya guardada (archivo JSON de data/modelos/corridas). */
    cargar(corrida) {
      const config = { lat: corrida.lat, t_max: corrida.t_max, cuadros: Math.max(400, corrida.tiempos.length * 2) }
      Object.assign(d, { config, tiempos: corrida.tiempos, cuadros: corrida.B, actividad: corrida.actividad,
        vmax: Math.max(...corrida.B.map((f) => Math.max(...f.map(Math.abs)))), enCurso: false,
        aniosPorUnidad: corrida.resumen?.anios_por_unidad ?? null })
      lienzo.canvas = null
      programar()
    },
    alTema() {
      lut = construirLUT()
      if (d.config) pintar(true)
      programar()
    },
    get datos() {
      return d
    },
  }
}

export function crearVisorSerie(contenedor) {
  contenedor.classList.add('visor')
  contenedor.innerHTML = `
    <div class="leyenda-serie">
      <span><i style="background:var(--serie-2)"></i>Modelo: S(t) = s₀ x²</span>
      <span><i style="background:var(--serie-1)"></i>Observado: número de manchas SILSO (media de 13 meses)</span>
    </div>
    <div class="grafico g-serie"></div>`
  const d = { anios: [], S: [], obsA: [], obsS: [] }
  let pendiente = false

  const g = registrarGrafico(contenedor.querySelector('.g-serie'), () => ({
    height: 320,
    cursor: { points: { size: 6 } },
    scales: { x: { time: false } },
    axes: [eje({ size: 28 }), eje({ size: 44, label: 'Número de manchas', labelSize: 18 })],
    series: [
      { label: 'Año', value: (u, v) => (v == null ? '–' : v.toFixed(1)) },
      { label: 'Observado (SILSO)', stroke: token('--serie-1'), width: 2, spanGaps: true, points: { show: false }, value: (u, v) => numero(v) },
      { label: 'Modelo', stroke: token('--serie-2'), width: 1.6, spanGaps: true, points: { show: false }, value: (u, v) => numero(v) },
    ],
  }), [[], [], []])

  function render() {
    pendiente = false
    // Une los dos ejes de años: los meses observados y los puntos del modelo
    const xs = [...new Set([...d.obsA, ...d.anios])].sort((a, b) => a - b)
    const mapaObs = new Map(d.obsA.map((a, i) => [a, d.obsS[i]]))
    const mapaMod = new Map(d.anios.map((a, i) => [a, d.S[i]]))
    g.poner([xs, xs.map((a) => mapaObs.get(a) ?? null), xs.map((a) => mapaMod.get(a) ?? null)])
  }
  const programar = () => {
    if (!pendiente) {
      pendiente = true
      requestAnimationFrame(render)
    }
  }

  leerCSV('/datos/manchas_mensuales.csv')
    .then((filas) => {
      for (const f of filas) {
        const s = num(f.manchas_13m)
        if (s != null) {
          d.obsA.push(Math.round(Number(f.anio_decimal) * 1000) / 1000)
          d.obsS.push(s)
        }
      }
      programar()
    })
    .catch(() => {})

  return {
    configurar() {
      d.anios = []
      d.S = []
      programar()
    },
    agregar(anios, S) {
      d.anios.push(...anios)
      d.S.push(...S)
      programar()
    },
    terminar() {},
    cargar(corrida) {
      d.anios = corrida.anios
      d.S = corrida.S
      programar()
    },
    alTema() {},
  }
}


// ── Resumen y ecuación de una corrida (página pública y laboratorio) ──
const ETIQUETAS_RESUMEN = {
  periodo: ['Periodo', (v) => `${numero(v)} tiempos de difusión`],
  anios_por_unidad: ['1 tiempo de difusión', (v) => `≈ ${v.toLocaleString('es', { maximumFractionDigits: 1 })} años (ciclo magnético de 22 años)`],
  amplitud: ['Amplitud máxima |B|', numero],
  variacion_maximos: ['Variación entre ciclos', (v) => `${Math.round(v * 100)}% (desviación de los máximos)`],
}
const fila = (etiqueta, valor) => `<div><dt>${escapar(etiqueta)}</dt><dd>${valor}</dd></div>`

export function htmlResumen(c) {
  const r = c.resumen || {}
  let html = ''
  if (c.tipo === 'latitud') {
    if (!r.oscila) html += fila('Resultado', 'el campo no oscila con estos parámetros')
    for (const [k, [et, fmt]] of Object.entries(ETIQUETAS_RESUMEN)) if (r[k] != null) html += fila(et, escapar(fmt(r[k])))
    if (r.migracion) {
      const dir = { ecuador: 'hacia el ecuador', polos: 'hacia los polos' }[r.migracion.direccion] ?? ''
      html += fila('Migración de las bandas', `${numero(r.migracion.desde)}° → ${numero(r.migracion.hasta)}° ${dir}`)
    }
    return html
  }
  const m = r.modelo || {}
  const o = r.observado || {}
  const par = (a, b, fmt = numero) => `${a != null ? fmt(a) : '–'} <span class="suave">(observado: ${b != null ? fmt(b) : '–'})</span>`
  html += fila('Ciclos simulados', par(m.ciclos, o.ciclos))
  html += fila('Duración media del ciclo', `${par(m.periodo_medio, o.periodo_medio)} años`)
  html += fila('Máximo medio de manchas', par(m.maximo_medio, o.maximo_medio))
  html += fila('Variación entre máximos', par(m.variacion_maximos, o.variacion_maximos, (v) => `${Math.round(v * 100)}%`))
  if (r.correlacion != null) html += fila('Correlación mes a mes', `${numero(r.correlacion)} <span class="suave">(con ruido, el modelo no predice fechas)</span>`)
  return html
}

export function htmlParametros(c) {
  return Object.entries(c.parametros || {})
    .filter(([k]) => !['cuadros', 'anio_fin'].includes(k))
    .map(([k, v]) => fila(k, `<code>${escapar(String(v))}</code>`))
    .join('')
}

/** Escribe la ecuación (LaTeX) y la dibuja con MathJax; sin MathJax queda el texto. */
export async function mostrarEcuacion(el, latex) {
  el.textContent = latex ? `\\[${latex}\\]` : ''
  try {
    await window.MathJax?.startup?.promise
    window.MathJax?.typesetClear?.([el])
    await window.MathJax?.typesetPromise?.([el])
  } catch {
    // sin conexión al CDN de MathJax
  }
}
