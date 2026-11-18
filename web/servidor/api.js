// API de la página en vivo. La usan el servidor de desarrollo (vite.config.js) y el de
// producción (servidor/produccion.js), así que la página funciona igual en ambos.
//
//   POST /api/eventos    eventos de los scripts de Python (src/en_vivo.py); requiere token
//   GET  /api/stream     Server-Sent Events públicos: avisos de figuras y tablas actualizadas
//   GET  /api/archivos   figuras y tablas disponibles
//   GET  /api/mariposa   latitud de las fulguraciones (versión reducida de fulguraciones.csv)
//   GET  /api/sol/...    imágenes del Sol por día (servidor/sol.js)
//   GET  /figuras/*.png, /datos/*.csv, /datos/*.json
//   /api/meteo/*         datos meteorológicos: carga de Parquet y reprocesamiento (servidor/meteo.js)
//   /api/admin/*         laboratorio con contraseña (servidor/admin.js):
//     GET /api/admin/stream   todos los eventos de los scripts y modelos, en vivo
//     GET /api/admin/estado   últimas ejecuciones guardadas en memoria

import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { crearAdmin } from './admin.js'
import { crearMeteo } from './meteo.js'
import { rutasSol } from './sol.js'

const TIPOS = {
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}
const MAX_EJECUCIONES = 15
const MAX_EVENTOS = 8000
const MAX_CUERPO = 20 * 1024 * 1024 // un lote de cuadros del dínamo pesa unos pocos MB

function json(res, datos, estado = 200) {
  res.statusCode = estado
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(datos))
}

function listar(dir, extension) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(extension))
    .map((nombre) => {
      const st = fs.statSync(join(dir, nombre))
      return { nombre, mtime: st.mtimeMs, tam: st.size }
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
}

/** Token compartido con los scripts de Python: variable SOLAR_VIVO_TOKEN o .solar_vivo.json. */
function leerToken(raiz) {
  if (process.env.SOLAR_VIVO_TOKEN) return process.env.SOLAR_VIVO_TOKEN
  try {
    return JSON.parse(fs.readFileSync(join(raiz, '.solar_vivo.json'), 'utf8')).token || null
  } catch {
    return null
  }
}

const esLocal = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for']

/**
 * Crea el manejador de la API. Devuelve `manejar(req, res, next)` (estilo Connect).
 * Sin token configurado solo acepta eventos desde la misma máquina (modo desarrollo).
 */
export function crearApi(raiz) {
  const carpetas = { '/figuras/': join(raiz, 'figuras'), '/datos/': join(raiz, 'data', 'processed') }
  const ejecuciones = new Map()
  const clientes = new Set() // página pública
  const clientesAdmin = new Set() // laboratorio con sesión
  const sol = rutasSol(raiz)

  // ── Difusión a los navegadores (Server-Sent Events) ──
  function enviar(destinos, evento, datos) {
    const mensaje = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`
    for (const res of destinos) res.write(mensaje)
  }
  const difundir = (evento, datos) => {
    enviar(clientes, evento, datos)
    enviar(clientesAdmin, evento, datos)
  }
  const difundirAdmin = (evento, datos) => enviar(clientesAdmin, evento, datos)
  setInterval(() => {
    // mantiene viva la conexión a través de proxies
    for (const res of [...clientes, ...clientesAdmin]) res.write(': latido\n\n')
  }, 25000).unref()

  const admin = crearAdmin(raiz, { difundirAdmin })
  const meteo = crearMeteo(raiz, { sesionValida: admin.sesionValida })

  function guardar(ev) {
    if (!ev || typeof ev.ejecucion !== 'string' || typeof ev.tipo !== 'string') return false
    let e = ejecuciones.get(ev.ejecucion)
    if (!e) {
      e = { id: ev.ejecucion, script: ev.script, eventos: [] }
      ejecuciones.set(ev.ejecucion, e)
      while (ejecuciones.size > MAX_EJECUCIONES) ejecuciones.delete(ejecuciones.keys().next().value)
    }
    if (e.eventos.length < MAX_EVENTOS || ev.tipo === 'fin' || ev.tipo.endsWith('_fin')) e.eventos.push(ev)
    return true
  }

  function autorizado(req) {
    const token = leerToken(raiz)
    if (!token) return esLocal(req)
    const enviado = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''))
    const esperado = Buffer.from(token)
    return enviado.length === esperado.length && timingSafeEqual(enviado, esperado)
  }

  // ── Diagrama mariposa: fulguraciones.csv reducido a [tiempo, latitud, clase] ──
  let cacheMariposa = { mtime: 0, datos: null }
  function mariposa() {
    const ruta = join(carpetas['/datos/'], 'fulguraciones.csv')
    if (!fs.existsSync(ruta)) return null
    const mtime = fs.statSync(ruta).mtimeMs
    if (cacheMariposa.mtime === mtime) return cacheMariposa.datos
    const lineas = fs.readFileSync(ruta, 'utf8').split('\n')
    const cab = lineas[0].split(',')
    const iPico = cab.indexOf('pico')
    const iLetra = cab.indexOf('letra')
    const iLat = cab.indexOf('lat')
    const t = []
    const lat = []
    const clase = []
    for (let k = 1; k < lineas.length; k++) {
      const c = lineas[k].split(',')
      const letra = c[iLetra]
      if (c.length <= iLat || c[iLat] === '' || (letra !== 'C' && letra !== 'M' && letra !== 'X')) continue
      t.push(Date.parse(c[iPico].replace(' ', 'T') + 'Z'))
      lat.push(Number(c[iLat]))
      clase.push(letra)
    }
    cacheMariposa = { mtime, datos: { t, lat, clase: clase.join('') } }
    return cacheMariposa.datos
  }

  // ── Aviso cuando cambia una figura o una tabla ──
  for (const [prefijo, dir] of Object.entries(carpetas)) {
    fs.mkdirSync(dir, { recursive: true })
    const pendientes = new Map()
    fs.watch(dir, (_tipo, nombre) => {
      if (!nombre || nombre.startsWith('.') || nombre.endsWith('.part')) return
      clearTimeout(pendientes.get(nombre))
      pendientes.set(
        nombre,
        setTimeout(() => {
          pendientes.delete(nombre)
          fs.stat(join(dir, nombre), (err, st) =>
            difundir('solar:archivo', {
              carpeta: prefijo,
              nombre,
              url: prefijo + nombre,
              mtime: err ? null : st.mtimeMs,
              tam: err ? null : st.size,
            }),
          )
        }, 300),
      )
    })
  }

  function recibirEventos(req, res) {
    if (!autorizado(req)) return json(res, { error: 'No autorizado' }, 401)
    let cuerpo = ''
    let tam = 0
    req.setEncoding('utf8')
    req.on('data', (trozo) => {
      tam += trozo.length
      if (tam > MAX_CUERPO) req.destroy()
      else cuerpo += trozo
    })
    req.on('end', () => {
      let lote
      try {
        lote = JSON.parse(cuerpo)
      } catch {
        return json(res, { error: 'JSON inválido' }, 400)
      }
      if (!Array.isArray(lote)) lote = [lote]
      lote = lote.filter(guardar)
      // La salida de los scripts solo la ve el laboratorio; el público ve los resultados (archivos)
      if (lote.length) difundirAdmin('solar:eventos', lote)
      res.statusCode = 204
      res.end()
    })
  }

  function abrirStream(req, res, destinos) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: no acumular, enviar cada evento al instante
    })
    res.write('retry: 3000\n\n')
    destinos.add(res)
    req.on('close', () => destinos.delete(res))
  }

  function servirArchivo(req, res, url, prefijo) {
    const base = carpetas[prefijo]
    const ruta = resolve(base, url.slice(prefijo.length))
    if (!ruta.startsWith(base + sep) || !TIPOS[extname(ruta)]) return json(res, { error: 'Prohibido' }, 403)
    fs.stat(ruta, (err, st) => {
      if (err || !st.isFile()) return json(res, { error: `No existe: ${url}` }, 404)
      res.setHeader('Content-Type', TIPOS[extname(ruta)])
      res.setHeader('Cache-Control', 'no-store')
      fs.createReadStream(ruta).pipe(res)
    })
  }

  return function manejar(req, res, next) {
    let url
    try {
      url = decodeURIComponent((req.url || '').split('?')[0])
    } catch {
      return json(res, { error: 'URL inválida' }, 400)
    }
    if (url === '/api/eventos' && req.method === 'POST') return recibirEventos(req, res)
    if (url.startsWith('/api/meteo/')) return meteo.manejar(req, res, url.slice('/api/meteo'.length))
    if (url.startsWith('/api/admin/')) {
      const ruta = url.slice('/api/admin'.length)
      if (ruta === '/stream' || ruta === '/estado') {
        if (!admin.sesionValida(req)) return json(res, { error: 'Inicie sesión' }, 401)
        return ruta === '/stream' ? abrirStream(req, res, clientesAdmin) : json(res, [...ejecuciones.values()])
      }
      return admin.manejar(req, res, ruta)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (url === '/api/stream') return abrirStream(req, res, clientes)
    if (url === '/api/archivos') {
      return json(res, { figuras: listar(carpetas['/figuras/'], '.png'), datos: listar(carpetas['/datos/'], '.csv') })
    }
    if (url === '/api/mariposa') {
      const datos = mariposa()
      return datos ? json(res, datos) : json(res, { error: 'Falta data/processed/fulguraciones.csv: ejecute npm run procesar' }, 404)
    }
    if (url.startsWith('/api/sol/')) {
      req.url = req.url.slice('/api/sol'.length)
      return sol(req, res, () => json(res, { error: 'No existe' }, 404))
    }
    const prefijo = Object.keys(carpetas).find((p) => url.startsWith(p))
    if (prefijo) return servirArchivo(req, res, url, prefijo)
    next()
  }
}
