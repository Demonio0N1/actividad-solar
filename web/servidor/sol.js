// Imágenes del disco solar por día, desde el archivo de SOHO:
//   SOHO/MDI  19-05-1996 a 11-01-2011  (carpetas mdiigr = luz visible, mdimag = campo magnético)
//   SDO/HMI   01-01-2011 a hoy         (carpetas hmiigr, hmimag)
// Unas 16 imágenes de 1024 px por día. Cada imagen pedida se guarda en data/raw/sol/AAAA/
// y se sirve desde ahí las siguientes veces.
//
// Rutas:
//   GET /api/sol/lista?fecha=AAAA-MM-DD&tipo=continuo|magnetograma   horas disponibles ese día
//   GET /api/sol/imagen?fecha=...&tipo=...&hora=HHMM[&descargar=1]  la imagen (JPEG)
//   GET /api/sol/dia?fecha=...                                       manchas y fulguraciones de ese día

import fs from 'node:fs'
import { join } from 'node:path'

const SOHO = 'https://soho.nascom.nasa.gov/data/REPROCESSING/Completed'
const CARPETAS = { continuo: { mdi: 'mdiigr', hmi: 'hmiigr' }, magnetograma: { mdi: 'mdimag', hmi: 'hmimag' } }
export const PRIMER_DIA = '1996-05-19'
const INSTRUMENTO = { mdi: 'SOHO/MDI', hmi: 'SDO/HMI' }

function json(res, datos, estado = 200) {
  res.statusCode = estado
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(datos))
}

/** Valida los parámetros comunes. Devuelve { fecha: 'AAAAMMDD', iso, tipo } o un mensaje de error. */
function parametros(url) {
  const q = new URL(url, 'http://x').searchParams
  const iso = q.get('fecha') ?? ''
  const tipo = q.get('tipo') ?? 'continuo'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(iso))) return { error: 'Fecha inválida: use AAAA-MM-DD' }
  if (!CARPETAS[tipo]) return { error: 'Tipo inválido: continuo o magnetograma' }
  return { iso, fecha: iso.replaceAll('-', ''), tipo, hora: q.get('hora'), descargar: q.has('descargar') }
}

// El cambio de MDI a HMI: el 1 al 11 de enero de 2011 hay de los dos; se prefiere HMI
function instrumentos(fecha) {
  if (fecha < '20110101') return ['mdi']
  if (fecha > '20110111') return ['hmi']
  return ['hmi', 'mdi']
}

const diaUTC = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '')
const cacheListas = new Map()

/** Imágenes de 1024 px disponibles un día: [{ hora: 'HHMM', archivo, url, instrumento }]. */
async function listar(fecha, tipo) {
  const clave = `${fecha}-${tipo}`
  const c = cacheListas.get(clave)
  // Los días pasados no cambian; el de hoy y el de ayer se vuelven a consultar cada 10 minutos
  const reciente = fecha >= diaUTC(Date.now() - 86400000)
  if (c && (!reciente || Date.now() - c.t < 10 * 60 * 1000)) return c.lista
  let lista = []
  for (const inst of instrumentos(fecha)) {
    const carpeta = CARPETAS[tipo][inst]
    const dir = `${SOHO}/${fecha.slice(0, 4)}/${carpeta}/${fecha}/`
    const r = await fetch(dir, { signal: AbortSignal.timeout(30000) })
    if (r.status === 404) continue
    if (!r.ok) throw new Error(`SOHO respondió ${r.status} para ${dir}`)
    const html = await r.text()
    const patron = new RegExp(`${fecha}_(\\d{4})_${carpeta}_1024\\.jpg`, 'g')
    const horas = [...new Set([...html.matchAll(patron)].map((m) => m[1]))].sort()
    lista = horas.map((hora) => ({
      hora,
      archivo: `${fecha}_${hora}_${carpeta}_1024.jpg`,
      url: `${dir}${fecha}_${hora}_${carpeta}_1024.jpg`,
      instrumento: INSTRUMENTO[inst],
    }))
    if (lista.length) break
  }
  cacheListas.set(clave, { t: Date.now(), lista })
  return lista
}

const descargasEnCurso = new Map()

// En un servidor público, cada imagen nueva ocupa ~0.3 MB en disco. Se limita cuántas
// imágenes *nuevas* puede pedir cada visitante; las ya guardadas se sirven sin límite.
const LIMITE_DESCARGAS = Number(process.env.SOLAR_LIMITE_IMAGENES || 60) // por visitante cada 10 min
const VENTANA_MS = 10 * 60 * 1000
const descargasPorVisitante = new Map()

function visitante(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
}

function puedeDescargar(req) {
  const ahora = Date.now()
  const quien = visitante(req)
  const recientes = (descargasPorVisitante.get(quien) || []).filter((t) => ahora - t < VENTANA_MS)
  if (recientes.length >= LIMITE_DESCARGAS) return false
  recientes.push(ahora)
  descargasPorVisitante.set(quien, recientes)
  if (descargasPorVisitante.size > 5000) descargasPorVisitante.clear()
  return true
}

const rutaLocal = (raiz, item) => join(raiz, 'data', 'raw', 'sol', item.archivo.slice(0, 4), item.archivo)

/** Devuelve la ruta local de la imagen; la descarga de SOHO la primera vez. */
function obtenerImagen(raiz, item) {
  const destino = rutaLocal(raiz, item)
  if (fs.existsSync(destino)) return Promise.resolve(destino)
  if (descargasEnCurso.has(destino)) return descargasEnCurso.get(destino)
  const promesa = (async () => {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(60000) })
    if (!r.ok) throw new Error(`SOHO respondió ${r.status} para ${item.url}`)
    fs.mkdirSync(join(destino, '..'), { recursive: true })
    const tmp = `${destino}.part`
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()))
    fs.renameSync(tmp, destino)
    return destino
  })().finally(() => descargasEnCurso.delete(destino))
  descargasEnCurso.set(destino, promesa)
  return promesa
}

// Índices por día de las tablas procesadas (se rehacen si el CSV cambia)
const indices = new Map()
// Devuelve { indice: Map(dia -> datos), hasta: último día con datos } o null si falta el CSV
function indicePorDia(ruta, construir, tieneDato = () => true) {
  if (!fs.existsSync(ruta)) return null
  const mtime = fs.statSync(ruta).mtimeMs
  const c = indices.get(ruta)
  if (c?.mtime === mtime) return c
  const [cab, ...filas] = fs.readFileSync(ruta, 'utf8').trim().split('\n')
  const cols = cab.split(',')
  const indice = new Map()
  for (const f of filas) {
    const v = f.split(',')
    construir(indice, Object.fromEntries(cols.map((c, i) => [c, v[i]])))
  }
  let hasta = null
  for (const [dia, datos] of indice) if (tieneDato(datos) && (!hasta || dia > hasta)) hasta = dia
  const entrada = { mtime, indice, hasta }
  indices.set(ruta, entrada)
  return entrada
}

function datosDelDia(raiz, iso) {
  const proc = join(raiz, 'data', 'processed')
  const manchas = indicePorDia(join(proc, 'manchas_diarias.csv'), (ind, f) =>
    ind.set(f.fecha, {
      manchas: f.manchas === '' ? null : Number(f.manchas),
      provisional: f.definitivo === '0',
      fuente: f.fuente || 'SILSO', // 'EISN' = estimación diaria, solo después del último valor oficial
      estaciones: f.n_obs === '' ? null : Number(f.n_obs),
    }),
    (d) => d.manchas != null,
  )
  const fulg = indicePorDia(join(proc, 'fulguraciones.csv'), (ind, f) => {
    const dia = f.pico.slice(0, 10)
    if (!ind.has(dia)) ind.set(dia, [])
    ind.get(dia).push({
      clase: f.clase,
      letra: f.letra,
      pico: f.pico.slice(11, 16),
      flujo: Number(f.flujo_pico),
      lat: f.lat === '' ? null : Number(f.lat),
      lon: f.lon === '' ? null : Number(f.lon),
      region: f.region_activa === '' ? null : Number(f.region_activa),
    })
  })
  const eventos = fulg?.indice.get(iso) ?? []
  const cuenta = { C: 0, M: 0, X: 0 }
  for (const e of eventos) if (e.letra in cuenta) cuenta[e.letra]++
  return {
    fecha: iso,
    manchas: manchas?.indice.get(iso) ?? null,
    fulguraciones: cuenta,
    mayores: [...eventos].sort((a, b) => b.flujo - a.flujo).slice(0, 5),
    // Último día con datos en cada tabla: después de esa fecha "sin dato" no significa cero
    hasta: { manchas: manchas?.hasta ?? null, fulguraciones: fulg?.hasta ?? null },
  }
}

/** Middleware de Connect para las rutas /api/sol/*. */
export function rutasSol(raiz) {
  return async (req, res, next) => {
    const ruta = (req.url || '').split('?')[0]
    if (!['/lista', '/imagen', '/dia'].includes(ruta)) return next()
    const p = parametros(req.url)
    if (p.error) return json(res, { error: p.error }, 400)
    try {
      if (ruta === '/dia') return json(res, datosDelDia(raiz, p.iso))
      if (p.iso < PRIMER_DIA) {
        return json(res, { error: `No hay imágenes antes del ${PRIMER_DIA} (inicio de SOHO/MDI).`, lista: [] }, ruta === '/lista' ? 200 : 404)
      }
      const lista = await listar(p.fecha, p.tipo)
      if (ruta === '/lista') {
        return json(res, { fecha: p.iso, tipo: p.tipo, lista: lista.map(({ hora, instrumento, archivo }) => ({ hora, instrumento, archivo })) })
      }
      const item = lista.find((i) => i.hora === p.hora)
      if (!item) return json(res, { error: `No hay imagen a las ${p.hora} UT ese día` }, 404)
      if (!fs.existsSync(rutaLocal(raiz, item)) && !puedeDescargar(req)) {
        return json(res, { error: 'Demasiadas imágenes nuevas en poco tiempo. Espere unos minutos.' }, 429)
      }
      const local = await obtenerImagen(raiz, item)
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.setHeader('X-Archivo-Local', `data/raw/sol/${item.archivo.slice(0, 4)}/${item.archivo}`)
      if (p.descargar) {
        const nombre = `sol_${p.tipo}_${p.fecha}_${p.hora}UT.jpg`
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`)
      }
      fs.createReadStream(local).pipe(res)
    } catch (e) {
      json(res, { error: `No se pudo obtener la imagen de SOHO: ${e.message}` }, 502)
    }
  }
}
