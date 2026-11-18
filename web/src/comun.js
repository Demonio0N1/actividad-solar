// Utilidades compartidas por las páginas del sitio.

// Conexión en vivo con el servidor (Server-Sent Events). Hay dos canales:
//   /api/stream        público: avisos de figuras y tablas actualizadas
//   /api/admin/stream  laboratorio (con sesión): además, todo lo que hacen los scripts y modelos
// EventSource reintenta solo si se corta; funciona igual con npm run dev y npm start.

/** Abre un canal y devuelve { on(evento, fn), alEstado(fn), cerrar() }. */
export function abrirCanal(url) {
  const oyentes = new Map()
  const oyentesEstado = new Set()
  let estado = 'conectando'
  const fuente = new EventSource(url)
  const avisar = (nuevo) => {
    estado = nuevo
    for (const fn of oyentesEstado) fn(nuevo)
  }
  fuente.addEventListener('open', () => avisar('conectado'))
  fuente.addEventListener('error', () => avisar('desconectado'))
  return {
    on(evento, fn) {
      if (!oyentes.has(evento)) {
        oyentes.set(evento, new Set())
        fuente.addEventListener(evento, (e) => {
          const datos = JSON.parse(e.data)
          for (const f of oyentes.get(evento)) f(datos)
        })
      }
      oyentes.get(evento).add(fn)
    },
    alEstado(fn) {
      oyentesEstado.add(fn)
      fn(estado)
    },
    cerrar() {
      fuente.close()
    },
  }
}

let publico = null
const canalPublico = () => (publico ??= abrirCanal('/api/stream'))

/** Mantiene actualizado el indicador de conexión con el servidor. */
export function indicadorConexion(el = document.getElementById('conexion'), canal = canalPublico()) {
  const textos = { conectando: 'conectando…', conectado: 'en vivo', desconectado: 'sin conexión' }
  canal.alEstado((estado) => {
    if (!el) return
    el.dataset.estado = estado === 'conectando' ? 'sin-servidor' : estado
    el.textContent = textos[estado]
  })
}

/** Llama a `fn(archivo)` cada vez que cambia algo en figuras/ o data/processed/. */
export function alCambiarArchivo(fn, canal = canalPublico()) {
  canal.on('solar:archivo', fn)
}

/** Lee un token de color de la hoja de estilos. */
export function token(nombre) {
  return getComputedStyle(document.documentElement).getPropertyValue(nombre).trim()
}

/** Llama a `fn` cuando el sistema cambia entre tema claro y oscuro. */
export function alCambiarTema(fn) {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fn)
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

export function escapar(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function hace(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `hace ${s} s`
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`
  return `hace ${Math.floor(s / 3600)} h`
}
