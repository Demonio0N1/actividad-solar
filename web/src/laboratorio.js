// Laboratorio con contraseña: elegir y modificar modelos, correrlos en vivo y publicar resultados.
import './vivo.css'
import './laboratorio.css'
import { abrirCanal, alCambiarTema, escapar, hace, indicadorConexion } from './comun.js'
import { $, hora, numero, rehacerGraficos, segundos } from './graficos.js'
import { crearVisorLatitud, crearVisorSerie, htmlResumen, mostrarEcuacion } from './visor.js'

const estado = {
  modelos: {},
  modelo: null,
  valores: {}, // por modelo
  errores: {},
  visor: null,
  geometria: null,
  corrida: null, // id de la última corrida terminada (para publicar)
  publicada: null,
  corriendo: null,
}
const ejecuciones = new Map()
const consola = []

// ───────────────────────── API ─────────────────────────
async function api(ruta, cuerpo) {
  const r = await fetch(`/api/admin${ruta}`, cuerpo === undefined ? { cache: 'no-store' } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  const datos = await r.json().catch(() => ({}))
  if (r.status === 401 && ruta !== '/entrar') {
    mostrarEntrar('Su sesión terminó. Vuelva a entrar.')
    throw new Error('sin sesión')
  }
  if (!r.ok) throw Object.assign(new Error(datos.error || `Error ${r.status}`), { datos })
  return datos
}

function guardarLocal() {
  try {
    localStorage.setItem('lab-valores', JSON.stringify({ modelo: estado.modelo, valores: estado.valores }))
  } catch {
    // sin almacenamiento local: no pasa nada
  }
}
function leerLocal() {
  try {
    return JSON.parse(localStorage.getItem('lab-valores')) || {}
  } catch {
    return {}
  }
}

// ───────────────────────── Acceso ─────────────────────────
function mostrarEntrar(mensaje) {
  $('vista-entrar').hidden = false
  $('vista-lab').hidden = true
  $('salir').hidden = true
  $('conexion').hidden = true
  const err = $('error-entrar')
  err.hidden = !mensaje
  err.textContent = mensaje || ''
  $('contrasena').focus()
}

$('form-entrar').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const boton = ev.target.querySelector('button')
  boton.disabled = true
  try {
    await api('/entrar', { contrasena: $('contrasena').value })
    $('contrasena').value = ''
    await mostrarLab()
  } catch (e) {
    mostrarEntrar(e.message)
  } finally {
    boton.disabled = false
  }
})

$('salir').addEventListener('click', async () => {
  await api('/salir', {}).catch(() => {})
  location.reload()
})

// ───────────────────────── Modelos y formulario ─────────────────────────
function valoresPorDefecto(clave) {
  return Object.fromEntries(estado.modelos[clave].parametros.map((p) => [p.clave, p.defecto]))
}

function renderSelector() {
  $('selector-modelos').innerHTML = Object.entries(estado.modelos)
    .sort(([, a], [, b]) => a.numero - b.numero)
    .map(([clave, m]) => `
      <button type="button" class="tarjeta-modelo" role="radio" aria-checked="${clave === estado.modelo}" data-modelo="${clave}">
        <span class="num">Modelo ${m.numero}</span>
        <span class="nombre">${escapar(m.nombre)}</span>
        <span class="tipo">${m.tipo === 'serie' ? 'serie de tiempo' : 'latitud y tiempo'}</span>
      </button>`)
    .join('')
}

$('selector-modelos').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-modelo]')
  if (b) elegirModelo(b.dataset.modelo)
})

function elegirModelo(clave) {
  estado.modelo = clave
  estado.valores[clave] ??= valoresPorDefecto(clave)
  renderSelector()
  renderFormulario()
  $('modelo-descripcion').textContent = estado.modelos[clave].descripcion
  if (!estado.corriendo) prepararVisor(estado.modelos[clave].tipo)
  guardarLocal()
  validarPronto()
}

function campoHTML(p, valor) {
  const id = `p-${p.clave}`
  let control
  if (p.tipo === 'opcion') {
    control = `<select id="${id}" name="${p.clave}">${p.opciones
      .map((o) => `<option value="${escapar(String(o.valor))}" ${String(o.valor) === String(valor) ? 'selected' : ''}>${escapar(o.etiqueta)}</option>`)
      .join('')}</select>`
  } else if (p.tipo === 'formula') {
    control = `<input type="text" id="${id}" name="${p.clave}" class="formula" value="${escapar(String(valor))}" spellcheck="false" autocomplete="off">`
  } else {
    control = `<input type="number" id="${id}" name="${p.clave}" value="${valor}" min="${p.min}" max="${p.max}" step="${p.paso}" inputmode="decimal">`
  }
  return `<div class="campo ${p.tipo === 'formula' ? 'ancho' : ''}" data-campo="${p.clave}">
    <label for="${id}">${escapar(p.etiqueta)}</label>
    ${control}
    ${p.ayuda ? `<p class="ayuda">${escapar(p.ayuda)}</p>` : ''}
    <p class="error-campo" hidden></p>
  </div>`
}

function renderFormulario() {
  const m = estado.modelos[estado.modelo]
  const valores = estado.valores[estado.modelo]
  $('form-param').innerHTML = m.parametros.map((p) => campoHTML(p, valores[p.clave] ?? p.defecto)).join('')
}

$('form-param').addEventListener('input', (ev) => {
  const el = ev.target
  if (!el.name) return
  const p = estado.modelos[estado.modelo].parametros.find((x) => x.clave === el.name)
  estado.valores[estado.modelo][el.name] = p.tipo === 'numero' || p.tipo === 'entero' ? Number(el.value) : el.value
  guardarLocal()
  validarPronto()
})

$('restablecer').addEventListener('click', () => {
  estado.valores[estado.modelo] = valoresPorDefecto(estado.modelo)
  renderFormulario()
  guardarLocal()
  validarPronto()
})

let temporizadorValidar = null
function validarPronto() {
  clearTimeout(temporizadorValidar)
  temporizadorValidar = setTimeout(validar, 350)
}

async function validar() {
  const modelo = estado.modelo
  try {
    const r = await api('/validar', { modelo, parametros: estado.valores[modelo] })
    if (modelo !== estado.modelo) return
    estado.errores = r.errores || {}
    for (const caja of document.querySelectorAll('[data-campo]')) {
      const msg = estado.errores[caja.dataset.campo]
      const p = caja.querySelector('.error-campo')
      p.hidden = !msg
      p.textContent = msg || ''
      caja.classList.toggle('invalido', !!msg)
    }
    actualizarBotones()
    if (r.ok) mostrarEcuacion($('ecuacion'), r.ecuacion)
  } catch {
    // sin sesión o sin servidor: lo maneja api()
  }
}

function actualizarBotones() {
  const hayErrores = Object.keys(estado.errores).length > 0
  $('correr').disabled = !!estado.corriendo || hayErrores
  $('detener').disabled = !estado.corriendo
  $('actualizar-datos').disabled = !!estado.corriendo
  $('publicar').disabled = !estado.corrida || estado.corrida === estado.publicada
  $('publicar').textContent = estado.corrida && estado.corrida === estado.publicada ? 'Publicada en la página' : 'Publicar en la página'
}

// ───────────────────────── Correr, detener, publicar ─────────────────────────
function ponerEstadoCorrida(clase, texto) {
  const chip = $('estado-corrida')
  chip.className = `chip ${clase}`
  chip.textContent = texto
}

$('correr').addEventListener('click', async () => {
  $('error-correr').hidden = true
  try {
    await api('/correr', { modelo: estado.modelo, parametros: estado.valores[estado.modelo] })
    estado.corriendo = 'modelo'
    estado.corrida = null
    ponerEstadoCorrida('curso', 'iniciando')
    actualizarBotones()
  } catch (e) {
    $('error-correr').hidden = false
    $('error-correr').textContent = e.message
  }
})

$('detener').addEventListener('click', () => api('/detener', {}).catch(() => {}))

$('publicar').addEventListener('click', async () => {
  if (!estado.corrida) return
  try {
    await api('/publicar', { corrida: estado.corrida })
    estado.publicada = estado.corrida
    $('lab-nota').textContent = 'Publicada: la página pública ya muestra este resultado.'
    actualizarBotones()
    cargarCorridas()
  } catch (e) {
    $('lab-nota').textContent = `No se pudo publicar: ${e.message}`
  }
})

$('actualizar-datos').addEventListener('click', async () => {
  try {
    await api('/actualizar', {})
    estado.corriendo = 'actualizar'
    actualizarBotones()
  } catch (e) {
    alertaNota(e.message)
  }
})

function alertaNota(texto) {
  $('lab-nota').textContent = texto
}

function prepararVisor(geometria) {
  if (estado.geometria === geometria && estado.visor) return estado.visor
  estado.visor = geometria === 'serie'
    ? crearVisorSerie($('lab-visor'))
    : crearVisorLatitud($('lab-visor'), { vacio: 'Elija un modelo y pulse <b>Correr</b>.' })
  estado.geometria = geometria
  return estado.visor
}

// Eventos de la corrida en curso (y de la actualización diaria del modelo publicado)
function eventoModelo(ev) {
  if (ev.tipo === 'modelo_config') {
    const v = prepararVisor(ev.geometria)
    v.configurar({ lat: ev.lat, t_max: ev.t_max, cuadros: ev.cuadros, anio_inicio: ev.anio_inicio })
    ponerEstadoCorrida('curso', `corriendo: ${ev.nombre}`)
    $('lab-resumen').innerHTML = ''
    $('lab-nota').textContent = ''
    if (ev.ecuacion) mostrarEcuacion($('ecuacion'), ev.ecuacion)
  } else if (ev.tipo === 'modelo_cuadro') {
    if (!estado.visor) return
    if (ev.anios) estado.visor.agregar(ev.anios, ev.S)
    else estado.visor.agregar(ev.tiempo, ev.B)
  } else if (ev.tipo === 'modelo_fin') {
    estado.visor?.terminar(ev.resumen)
    estado.corrida = ev.corrida
    ponerEstadoCorrida('ok', 'terminada')
    $('lab-resumen').innerHTML = htmlResumen({ tipo: ev.geometria, resumen: ev.resumen })
    actualizarBotones()
    cargarCorridas()
  }
}

function eventoProceso(p) {
  if (p.corriendo) {
    estado.corriendo = p.nombre
  } else {
    estado.corriendo = null
    if (p.codigo) {
      if (p.nombre === 'modelo') ponerEstadoCorrida('error', p.senal ? 'detenida' : 'error')
      alertaNota(p.senal ? 'La corrida se detuvo.' : `Terminó con error: ${p.error || 'revise la consola'}`)
    }
  }
  actualizarBotones()
}

// ───────────────────────── Corridas guardadas ─────────────────────────
async function cargarCorridas() {
  let lista = []
  try {
    lista = await api('/corridas')
    const pub = await fetch('/datos/modelo_publicado.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    estado.publicada = pub?.id ?? null
  } catch {
    return
  }
  actualizarBotones()
  $('corridas').innerHTML = lista.length
    ? lista.map((c) => {
        const r = c.resumen || {}
        const corto = r.modelo
          ? `ciclo ${numero(r.modelo.periodo_medio)} años · variación ${r.modelo.variacion_maximos != null ? Math.round(r.modelo.variacion_maximos * 100) + '%' : '–'}`
          : r.oscila ? `P = ${numero(r.periodo)} · ${numero(r.migracion?.desde)}° → ${numero(r.migracion?.hasta)}°` : 'no oscila'
        const publicada = c.id === estado.publicada
        return `<tr class="${publicada ? 'publicada' : ''}">
          <td>${escapar(hace(Date.parse(c.fecha)))}</td>
          <td>${escapar(c.nombre)}${publicada ? ' <span class="chip ok">publicada</span>' : ''}</td>
          <td class="mono">${escapar(corto)}</td>
          <td class="acciones-fila"><button type="button" class="boton-texto" data-ver="${c.id}">Ver</button>${publicada ? '' : `<button type="button" class="boton-texto" data-publicar="${c.id}">Publicar</button>`}</td>
        </tr>`
      }).join('')
    : '<tr><td colspan="4" class="suave">Todavía no hay corridas.</td></tr>'
}

$('corridas').addEventListener('click', async (ev) => {
  const ver = ev.target.closest('[data-ver]')?.dataset.ver
  const pub = ev.target.closest('[data-publicar]')?.dataset.publicar
  if (ver) {
    const c = await api(`/corrida?id=${encodeURIComponent(ver)}`)
    prepararVisor(c.tipo).cargar(c)
    estado.corrida = c.id
    ponerEstadoCorrida('ok', `corrida del ${new Date(c.fecha).toLocaleString('es')}`)
    $('lab-resumen').innerHTML = htmlResumen(c)
    if (estado.modelos[c.modelo]) {
      estado.valores[c.modelo] = { ...valoresPorDefecto(c.modelo), ...c.parametros }
      elegirModelo(c.modelo)
    }
    mostrarEcuacion($('ecuacion'), c.ecuacion)
    actualizarBotones()
    $('lab-visor').scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  if (pub) {
    await api('/publicar', { corrida: pub })
    estado.publicada = pub
    cargarCorridas()
  }
})

// ───────────────────────── Ejecuciones y consola ─────────────────────────
function obtenerEjecucion(ev) {
  let e = ejecuciones.get(ev.ejecucion)
  if (!e) {
    e = { id: ev.ejecucion, script: ev.script, argumentos: {}, inicio: ev.t, fin: null, estado: 'curso', duracion: null, error: null, progresos: new Map() }
    ejecuciones.set(e.id, e)
  }
  return e
}

function procesar(ev, enVivo = true) {
  const e = obtenerEjecucion(ev)
  if (ev.tipo === 'inicio') {
    e.inicio = ev.t
    e.argumentos = ev.argumentos ?? {}
  } else if (ev.tipo === 'log') {
    consola.push(ev)
    if (consola.length > 800) consola.splice(0, consola.length - 800)
  } else if (ev.tipo === 'progreso') {
    e.progresos.set(ev.clave, ev)
  } else if (ev.tipo === 'fin') {
    Object.assign(e, { fin: ev.t, estado: ev.estado, duracion: ev.duracion, error: ev.error ?? null })
  } else if (enVivo && ev.tipo.startsWith('modelo_')) {
    eventoModelo(ev)
  }
}

function htmlEjecucion(e) {
  const [clase, texto] = { curso: ['curso', 'en curso'], ok: ['ok', 'terminó'], error: ['error', 'error'] }[e.estado] ?? ['todo', e.estado]
  const tiempo = e.estado === 'curso' ? segundos((Date.now() - e.inicio) / 1000) : `${hace(e.fin ?? e.inicio)} · duró ${segundos(e.duracion)}`
  const args = Object.entries(e.argumentos).filter(([, v]) => v != null && v !== 'None').map(([k, v]) => `${k}=${v}`).join('  ')
  const progresos = [...e.progresos.values()]
  const hechos = progresos.filter((p) => p.total != null && p.hecho >= p.total).length
  const activo = progresos.filter((p) => !(p.total != null && p.hecho >= p.total)).at(-1)
  return `<article class="ejec ${clase}">
    <div class="ejec-cab"><span class="script">${escapar(e.script)}.py</span><span class="chip ${clase}">${texto}</span><span class="tiempo">${tiempo}</span></div>
    ${args ? `<p class="args">${escapar(args.slice(0, 300))}</p>` : ''}
    ${activo ? `<p class="args">${escapar(String(activo.clave).split('/').pop())} · ${escapar(activo.etiqueta || '')}</p>` : ''}
    ${progresos.length > 1 ? `<p class="resumen-prog">✓ ${hechos} de ${progresos.length} completos</p>` : ''}
    ${e.error ? `<p class="fallo">${escapar(e.error)}</p>` : ''}
  </article>`
}

function renderEjecuciones() {
  const lista = [...ejecuciones.values()].sort((a, b) => b.inicio - a.inicio).slice(0, 8)
  if (lista.length) $('ejecuciones').innerHTML = lista.map(htmlEjecucion).join('')
}

function renderConsola() {
  const el = $('consola')
  const alFinal = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  el.innerHTML = consola.length
    ? consola.slice(-400).map((l) => `<div class="linea${l.nivel === 'error' ? ' error' : ''}"><span class="hora">${hora(l.t)}</span><span class="de">${escapar(l.script)}</span><span class="texto">${escapar(l.texto)}</span></div>`).join('')
    : '<p class="vacia">La salida de los scripts y modelos aparecerá aquí.</p>'
  if (alFinal) el.scrollTop = el.scrollHeight
}
$('limpiar-consola').addEventListener('click', () => {
  consola.length = 0
  renderConsola()
})

let pendiente = false
function programar() {
  if (pendiente) return
  pendiente = true
  requestAnimationFrame(() => {
    pendiente = false
    renderEjecuciones()
    renderConsola()
  })
}

// ───────────────────────── Arranque ─────────────────────────
let canal = null

async function mostrarLab() {
  $('vista-entrar').hidden = true
  $('vista-lab').hidden = false
  $('salir').hidden = false
  $('conexion').hidden = false
  if (!canal) {
    canal = abrirCanal('/api/admin/stream')
    indicadorConexion($('conexion'), canal)
    canal.on('solar:eventos', (lote) => {
      for (const ev of lote) procesar(ev)
      programar()
    })
    canal.on('solar:proceso', eventoProceso)
  }
  estado.modelos = await api('/modelos')
  const guardado = leerLocal()
  estado.valores = guardado.valores || {}
  for (const [clave, v] of Object.entries(estado.valores)) {
    if (estado.modelos[clave]) estado.valores[clave] = { ...valoresPorDefecto(clave), ...v }
    else delete estado.valores[clave]
  }
  elegirModelo(estado.modelos[guardado.modelo] ? guardado.modelo : 'parker')
  prepararVisor(estado.modelos[estado.modelo].tipo)
  cargarCorridas()
  // Historial de ejecuciones (sin redibujar corridas viejas en el visor)
  try {
    for (const e of await api('/estado')) for (const ev of e.eventos) procesar(ev, false)
  } catch {
    // ignorar
  }
  programar()
  const s = await api('/sesion')
  estado.corriendo = s.corriendo
  actualizarBotones()
}

alCambiarTema(() => {
  rehacerGraficos()
  estado.visor?.alTema()
})
setInterval(() => ejecuciones.size && renderEjecuciones(), 1000)

;(async () => {
  try {
    const s = await (await fetch('/api/admin/sesion', { cache: 'no-store' })).json()
    if (s.activa) return mostrarLab()
    mostrarEntrar(s.configurada ? '' : 'El laboratorio todavía no tiene contraseña. En el servidor ejecute: ./setup_sun.sh contrasena')
  } catch {
    mostrarEntrar('No hay conexión con el servidor.')
  }
})()
