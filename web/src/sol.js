// "El Sol ese día": imagen del disco solar (SOHO/MDI o SDO/HMI) para una fecha,
// con los datos de manchas y fulguraciones de ese día y un botón para guardarla.
import { escapar } from './comun.js'

const $ = (id) => document.getElementById(id)
const PRIMER_DIA = '1996-05-19'
const VIVO_CADA_MS = 10 * 60 * 1000
const NOMBRE_TIPO = { continuo: 'en luz visible', magnetograma: 'del campo magnético' }

const estado = { fecha: null, tipo: 'continuo', lista: [], hora: null, vivo: false, pedido: 0 }

const hoyUTC = () => new Date().toISOString().slice(0, 10)
const horaTexto = (h) => `${h.slice(0, 2)}:${h.slice(2)}`
const tipoElegido = () => document.querySelector('input[name="sol-tipo"]:checked').value

function sumarDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function fechaLarga(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

async function pedirJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    return await r.json()
  } catch {
    return { error: 'No hay conexión con el servidor local. ¿Está corriendo npm run dev?' }
  }
}

function ponerEstado(clase, texto) {
  const chip = $('sol-estado')
  chip.className = `chip ${clase}`
  chip.textContent = texto
}

function cargando(texto) {
  const el = $('sol-cargando')
  el.hidden = !texto
  if (texto) el.textContent = texto
}

function mostrarMensaje(texto) {
  $('sol-img').hidden = true
  const vacio = $('sol-vacio')
  vacio.hidden = false
  vacio.innerHTML = `<p>${escapar(texto)}</p>`
  cargando(null)
  $('sol-hora').innerHTML = ''
  $('sol-hora').disabled = true
  $('sol-inst').textContent = '–'
  for (const id of ['sol-guardar', 'sol-abrir']) $(id).setAttribute('aria-disabled', 'true')
  $('sol-copia').textContent = ''
}

/** La hora disponible más cercana a `objetivo` (HHMM). */
function horaCercana(lista, objetivo) {
  const minutos = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(2))
  return lista.reduce((mejor, i) => (Math.abs(minutos(i.hora) - minutos(objetivo)) < Math.abs(minutos(mejor.hora) - minutos(objetivo)) ? i : mejor)).hora
}

function urlImagen(hora, descargar = false) {
  return `/api/sol/imagen?fecha=${estado.fecha}&tipo=${estado.tipo}&hora=${hora}${descargar ? '&descargar=1' : ''}`
}

/**
 * Carga la lista de imágenes de un día y muestra una.
 * `vivo`: muestra la más reciente y se actualiza sola cada 10 minutos.
 * `horaPreferida`: si se cambia de tipo o de día, se intenta mantener la hora.
 */
async function cargarDia(fecha, { vivo = false, horaPreferida = null, reintento = false } = {}) {
  const pedido = ++estado.pedido
  Object.assign(estado, { fecha, tipo: tipoElegido(), vivo })
  $('sol-fecha').value = fecha
  $('sol-fecha').max = hoyUTC()
  $('sol-siguiente').disabled = fecha >= hoyUTC()
  $('sol-anterior').disabled = fecha <= PRIMER_DIA

  if (fecha < PRIMER_DIA) {
    ponerEstado('todo', 'sin imagen')
    mostrarMensaje(`Las imágenes empiezan el ${fechaLarga(PRIMER_DIA)}, con SOHO/MDI. Elija una fecha posterior.`)
    mostrarDatosDia(await pedirJSON(`/api/sol/dia?fecha=${fecha}`))
    return
  }

  ponerEstado('curso', 'buscando')
  cargando('Buscando imágenes en SOHO…')
  const [lista, dia] = await Promise.all([
    pedirJSON(`/api/sol/lista?fecha=${fecha}&tipo=${estado.tipo}`),
    pedirJSON(`/api/sol/dia?fecha=${fecha}`),
  ])
  if (pedido !== estado.pedido) return // el usuario ya pidió otra cosa
  mostrarDatosDia(dia)

  const items = lista.lista ?? []
  if (!items.length && vivo && !reintento) {
    // Al comienzo del día UT puede no haber imágenes todavía: se muestra la última de ayer
    return cargarDia(sumarDias(fecha, -1), { vivo, reintento: true })
  }
  if (!items.length) {
    ponerEstado('error', 'sin imagen')
    mostrarMensaje(lista.error ?? `No hay imágenes ${NOMBRE_TIPO[estado.tipo]} para el ${fechaLarga(fecha)}. SOHO tuvo interrupciones (la más larga, de junio a octubre de 1998). Pruebe otro día.`)
    return
  }

  estado.lista = items
  const select = $('sol-hora')
  select.innerHTML = items.map((i) => `<option value="${i.hora}">${horaTexto(i.hora)} UT · ${escapar(i.instrumento)}</option>`).join('')
  select.disabled = false
  const hora = vivo ? items.at(-1).hora : horaCercana(items, horaPreferida ?? '1200')
  await mostrarImagen(hora)
}

async function mostrarImagen(hora) {
  const pedido = estado.pedido
  const item = estado.lista.find((i) => i.hora === hora)
  if (!item) return
  estado.hora = hora
  $('sol-hora').value = hora
  cargando('Descargando imagen de SOHO…')
  const url = urlImagen(hora)
  try {
    await new Promise((ok, mal) => {
      const previa = new Image()
      previa.onload = ok
      previa.onerror = mal
      previa.src = url
    })
  } catch {
    if (pedido !== estado.pedido) return
    ponerEstado('error', 'error')
    mostrarMensaje('SOHO no entregó la imagen. Puede ser un problema de conexión; pruebe de nuevo en un momento.')
    return
  }
  if (pedido !== estado.pedido) return

  const img = $('sol-img')
  img.src = url
  img.alt = `Disco solar ${NOMBRE_TIPO[estado.tipo]} el ${fechaLarga(estado.fecha)} a las ${horaTexto(hora)} UT (${item.instrumento})`
  img.hidden = false
  $('sol-vacio').hidden = true
  cargando(null)

  $('sol-inst').textContent = `${item.instrumento} · ${fechaLarga(estado.fecha)}, ${horaTexto(hora)} UT`
  const guardar = $('sol-guardar')
  guardar.href = urlImagen(hora, true)
  guardar.download = `sol_${estado.tipo}_${estado.fecha.replaceAll('-', '')}_${hora}UT.jpg`
  guardar.removeAttribute('aria-disabled')
  const abrir = $('sol-abrir')
  abrir.href = url
  abrir.removeAttribute('aria-disabled')
  $('sol-copia').textContent = `También quedó guardada en el proyecto: data/raw/sol/${estado.fecha.slice(0, 4)}/${item.archivo}`
  ponerEstado('ok', estado.vivo ? 'en vivo · cada 10 min' : 'lista')
}

function posicion(lat, lon) {
  if (lat == null || lon == null) return '–'
  return `${lat >= 0 ? 'N' : 'S'}${Math.abs(Math.round(lat))} ${lon >= 0 ? 'W' : 'E'}${Math.abs(Math.round(lon))}`
}

function mostrarDatosDia(dia) {
  if (!dia || dia.error) {
    $('sol-manchas').textContent = '–'
    $('sol-fulg').textContent = '–'
    $('sol-mayores').innerHTML = ''
    return
  }
  // Explica por qué falta un dato: tabla sin procesar, o día posterior a la última descarga
  const falta = (hasta) => !hasta
    ? '<span class="suave">falta ejecutar npm run procesar</span>'
    : dia.fecha > hasta
      ? `<span class="suave">aún no está en los datos descargados (llegan hasta el ${fechaLarga(hasta)}). Ejecute npm run descargar y npm run procesar.</span>`
      : null
  const m = dia.manchas
  const nota = !m ? ''
    : m.fuente === 'EISN'
      ? ` <span class="suave">(estimación diaria EISN con ${m.estaciones} estaciones; ${dia.fecha === hoyUTC() ? 'cambia durante el día y ' : ''}SILSO publica el valor oficial al mes siguiente)</span>`
      : m.provisional ? ' <span class="suave">(SILSO, provisional)</span>' : ' <span class="suave">(SILSO, definitivo)</span>'
  $('sol-manchas').innerHTML = falta(dia.hasta.manchas)
    ?? (m?.manchas == null ? '<span class="suave">sin dato ese día</span>' : `${m.manchas}${nota}`)

  const f = dia.fulguraciones
  const total = f.C + f.M + f.X
  $('sol-fulg').innerHTML = falta(dia.hasta.fulguraciones)
    ?? (total === 0 ? '<span class="suave">ninguna de clase C o mayor</span>' : `${f.C} C · ${f.M} M · ${f.X} X`)

  $('sol-mayores').innerHTML = dia.mayores.length
    ? `<table><thead><tr><th>Clase</th><th>Pico (UT)</th><th>Posición</th><th>Región</th></tr></thead><tbody>${dia.mayores
        .map((e) => `<tr><td class="clase-${escapar(e.letra)}">${escapar(e.clase)}</td><td>${escapar(e.pico)}</td><td>${posicion(e.lat, e.lon)}</td><td>${e.region ?? '–'}</td></tr>`)
        .join('')}</tbody></table>`
    : ''
}

/** Muestra un día concreto (lo usa el diagrama mariposa al hacer clic en una fulguración). */
export function verDia(fecha, horaPreferida = null) {
  cargarDia(fecha, { horaPreferida })
  $('sol').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
}

export function iniciarSol() {
  $('sol-form').addEventListener('submit', (ev) => {
    ev.preventDefault()
    const fecha = $('sol-fecha').value
    if (fecha) cargarDia(fecha)
  })
  $('sol-ahora').addEventListener('click', () => cargarDia(hoyUTC(), { vivo: true }))
  $('sol-anterior').addEventListener('click', () => estado.fecha && cargarDia(sumarDias(estado.fecha, -1), { horaPreferida: estado.hora }))
  $('sol-siguiente').addEventListener('click', () => estado.fecha && cargarDia(sumarDias(estado.fecha, 1), { horaPreferida: estado.hora }))
  $('sol-hora').addEventListener('change', (ev) => {
    estado.vivo = false
    mostrarImagen(ev.target.value)
  })
  for (const radio of document.querySelectorAll('input[name="sol-tipo"]')) {
    radio.addEventListener('change', () => estado.fecha && cargarDia(estado.fecha, { vivo: estado.vivo, horaPreferida: estado.hora }))
  }
  // En modo en vivo se busca una imagen nueva cada 10 minutos (si la pestaña está visible)
  setInterval(() => {
    if (estado.vivo && document.visibilityState === 'visible') cargarDia(hoyUTC(), { vivo: true })
  }, VIVO_CADA_MS)

  cargarDia(hoyUTC(), { vivo: true })
}
