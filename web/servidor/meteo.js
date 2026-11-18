// Datos meteorológicos: carga de archivos nuevos y reprocesamiento automático.
//
// Los Parquet de las estaciones están en Metorologia/<tabla>.parquet. Cuando uno cambia (subido desde
// la página, copiado con rsync o escrito por la adquisición) se vuelve a correr src/meteorologia.py, que
// regenera data/processed/meteo/; la pestaña Meteorología lo nota sola.
//
//   GET  /api/meteo/archivos             Parquet actuales y estado del procesamiento        (público)
//   POST /api/meteo/subir?nombre=X       cuerpo: el .parquet. Lo deja en espera y lo valida (con sesión)
//                                        → { id, validacion }
//   POST /api/meteo/confirmar  { id }    reemplaza Metorologia/X (guarda una copia del anterior) (con sesión)
//   POST /api/meteo/descartar  { id }                                                        (con sesión)
//   POST /api/meteo/procesar             vuelve a procesar ahora                             (con sesión)
//
// La sesión es la del laboratorio (misma contraseña, comprobada en el servidor).

import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'

const MAX_ARCHIVO = 200 * 1024 * 1024
const ESPERA_MS = 60 * 60 * 1000 // un archivo subido sin confirmar se borra a la hora
const COPIAS = 3 // copias anteriores que se guardan por estación
const NOMBRE_VALIDO = /^[A-Za-z0-9_-]{1,64}\.parquet$/
const RETARDO_MS = 3000 // espera tras el último cambio antes de procesar

function json(res, datos, estado = 200) {
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(datos))
}

function leerJSON(req, maximo = 4096) {
  return new Promise((resolver, rechazar) => {
    let cuerpo = ''
    req.setEncoding('utf8')
    req.on('data', (t) => {
      cuerpo += t
      if (cuerpo.length > maximo) {
        rechazar(new Error('Cuerpo demasiado grande'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolver(cuerpo ? JSON.parse(cuerpo) : {})
      } catch {
        rechazar(new Error('JSON inválido'))
      }
    })
  })
}

function mismoOrigen(req) {
  const origen = req.headers.origin
  if (!origen) return true
  try {
    return new URL(origen).host === req.headers.host
  } catch {
    return false
  }
}

export function crearMeteo(raiz, { sesionValida }) {
  const carpeta = join(raiz, 'Metorologia')
  const espera = join(carpeta, '.subidas')
  const anteriores = join(carpeta, '.anteriores')
  const python = join(raiz, '.venv', 'bin', 'python')
  const script = join(raiz, 'src', 'meteorologia.py')
  const pendientes = new Map() // id -> { nombre, ruta, creado, validacion }
  const proc = { corriendo: false, programado: false, otraVez: false, ultimo: null, inicio: null }
  let temporizador = null

  fs.mkdirSync(espera, { recursive: true })
  fs.mkdirSync(anteriores, { recursive: true })
  // restos de una ejecución anterior del servidor
  for (const n of fs.readdirSync(espera)) fs.rmSync(join(espera, n), { force: true })

  // ── Procesamiento (uno a la vez; si llega otro cambio mientras corre, se repite al terminar) ──
  function procesar(motivo) {
    proc.programado = false
    if (proc.corriendo) {
      proc.otraVez = true
      return
    }
    proc.corriendo = true
    proc.inicio = Date.now()
    let salida = ''
    const hijo = spawn(python, [script], { cwd: raiz, stdio: ['ignore', 'pipe', 'pipe'] })
    const guardar = (t) => (salida = (salida + t).slice(-6000))
    hijo.stdout.on('data', guardar)
    hijo.stderr.on('data', guardar)
    const fin = (codigo, error) => {
      proc.corriendo = false
      proc.ultimo = { motivo, inicio: proc.inicio, fin: Date.now(), ok: codigo === 0, error, salida: salida.trim().split('\n').slice(-12).join('\n') }
      if (codigo !== 0) console.error(`[meteorología] el procesamiento falló (${motivo}):\n${proc.ultimo.salida}`)
      if (proc.otraVez) {
        proc.otraVez = false
        procesar('cambios durante el procesamiento')
      }
    }
    hijo.on('close', (codigo) => fin(codigo, codigo ? `terminó con código ${codigo}` : null))
    hijo.on('error', (e) => fin(-1, e.message))
  }

  function programar(motivo) {
    clearTimeout(temporizador)
    proc.programado = true
    temporizador = setTimeout(() => procesar(motivo), RETARDO_MS)
  }

  // Cualquier .parquet nuevo o modificado en Metorologia/ dispara el procesamiento. Se ignoran los
  // temporales (la adquisición escribe .tmp.parquet y luego lo renombra) y las carpetas ocultas.
  try {
    fs.watch(carpeta, (_tipo, nombre) => {
      if (!nombre || nombre.startsWith('.') || !nombre.endsWith('.parquet') || nombre.includes('.tmp')) return
      programar(`cambió ${nombre}`)
    })
  } catch (e) {
    console.error(`[meteorología] no se puede vigilar ${carpeta}: ${e.message}`)
  }

  // Al arrancar: si algún Parquet cambió mientras el servidor estaba apagado, se procesa ahora.
  try {
    const procesados = JSON.parse(fs.readFileSync(join(raiz, 'data', 'processed', 'meteo', 'estaciones.json'), 'utf8')).estaciones
    const vistos = new Map(procesados.map((e) => [`${e.tabla}.parquet`, Date.parse(e.archivo_modificado)]))
    const cambiados = archivos().filter((a) => !vistos.has(a.nombre) || Math.abs(vistos.get(a.nombre) - a.mtime) > 2000)
    if (cambiados.length) programar(`al arrancar: ${cambiados.map((a) => a.nombre).join(', ')} sin procesar`)
  } catch {
    if (archivos().length) programar('al arrancar: no había datos procesados')
  }

  setInterval(() => {
    for (const [id, p] of pendientes) {
      if (Date.now() - p.creado > ESPERA_MS) {
        fs.rmSync(p.ruta, { force: true })
        pendientes.delete(id)
      }
    }
  }, 10 * 60 * 1000).unref()

  function archivos() {
    if (!fs.existsSync(carpeta)) return []
    return fs
      .readdirSync(carpeta)
      .filter((n) => NOMBRE_VALIDO.test(n))
      .map((nombre) => {
        const st = fs.statSync(join(carpeta, nombre))
        const copias = fs.readdirSync(anteriores).filter((c) => c.startsWith(`${nombre.slice(0, -8)}__`)).sort().reverse()
        return { nombre, tam: st.size, mtime: st.mtimeMs, copias }
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
  }

  function validar(ruta, nombre) {
    return new Promise((resolver, rechazar) => {
      execFile(python, [script, '--validar', ruta, '--nombre', nombre], { cwd: raiz, timeout: 120000, maxBuffer: 1024 * 1024 },
        (err, salida, errores) => {
          if (err) return rechazar(new Error((errores || err.message).trim().split('\n').pop()))
          try {
            resolver(JSON.parse(salida.trim().split('\n').pop()))
          } catch {
            rechazar(new Error('Respuesta inválida al validar'))
          }
        })
    })
  }

  /** Guarda el cuerpo de la petición en un archivo, con límite de tamaño. */
  function recibirArchivo(req, ruta) {
    return new Promise((resolver, rechazar) => {
      let tam = 0
      const destino = fs.createWriteStream(ruta)
      req.on('data', (t) => {
        tam += t.length
        if (tam > MAX_ARCHIVO) {
          req.unpipe(destino)
          destino.destroy()
          req.destroy()
          rechazar(new Error(`El archivo pasa de ${MAX_ARCHIVO / 1024 / 1024} MB`))
        }
      })
      req.pipe(destino)
      destino.on('finish', () => resolver(tam))
      destino.on('error', rechazar)
      req.on('error', rechazar)
    })
  }

  function guardarCopia(nombre) {
    const actual = join(carpeta, nombre)
    if (!fs.existsSync(actual)) return null
    const sello = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
    const copia = `${nombre.slice(0, -8)}__${sello}.parquet`
    fs.copyFileSync(actual, join(anteriores, copia))
    const viejas = fs.readdirSync(anteriores).filter((c) => c.startsWith(`${nombre.slice(0, -8)}__`)).sort().reverse()
    for (const c of viejas.slice(COPIAS)) fs.rmSync(join(anteriores, c), { force: true })
    return copia
  }

  async function manejar(req, res, ruta) {
    if (ruta === '/archivos' && req.method === 'GET') {
      return json(res, {
        archivos: archivos(),
        procesando: proc.corriendo || proc.programado, // programado: esperando a que terminen de llegar cambios
        desde: proc.corriendo ? proc.inicio : null,
        ultimo: proc.ultimo && { ...proc.ultimo, salida: sesionValida(req) ? proc.ultimo.salida : undefined },
      })
    }
    if (req.method !== 'POST') return json(res, { error: 'No existe' }, 404)
    if (!mismoOrigen(req)) return json(res, { error: 'Origen no permitido' }, 403)
    if (!sesionValida(req)) return json(res, { error: 'Inicie sesión' }, 401)

    try {
      if (ruta.startsWith('/subir')) {
        const nombre = new URL(req.url, 'http://x').searchParams.get('nombre') || ''
        if (!NOMBRE_VALIDO.test(nombre)) {
          req.resume()
          return json(res, { error: 'El nombre debe ser <tabla>.parquet, con letras, números, guiones o guion bajo (p. ej. sangolqui.parquet).' }, 400)
        }
        const id = randomBytes(12).toString('hex')
        const temporal = join(espera, `${id}.parquet`)
        await recibirArchivo(req, temporal)
        const cabecera = Buffer.alloc(4)
        const fd = fs.openSync(temporal, 'r')
        fs.readSync(fd, cabecera, 0, 4, 0)
        fs.closeSync(fd)
        if (cabecera.toString() !== 'PAR1') {
          fs.rmSync(temporal, { force: true })
          return json(res, { error: 'El archivo no es un Parquet.' }, 400)
        }
        const validacion = await validar(temporal, nombre)
        if (!validacion.ok) {
          fs.rmSync(temporal, { force: true })
          return json(res, { validacion }, 422)
        }
        pendientes.set(id, { nombre, ruta: temporal, creado: Date.now(), validacion })
        return json(res, { id, validacion })
      }

      const datos = await leerJSON(req)
      if (ruta === '/confirmar' || ruta === '/descartar') {
        const p = pendientes.get(String(datos.id))
        if (!p) return json(res, { error: 'Ese archivo ya no está en espera. Súbalo de nuevo.' }, 404)
        pendientes.delete(String(datos.id))
        if (ruta === '/descartar') {
          fs.rmSync(p.ruta, { force: true })
          return json(res, { ok: true })
        }
        const copia = guardarCopia(p.nombre)
        // rename en el mismo disco: quien lea ve el archivo anterior o el nuevo, nunca uno a medias
        fs.renameSync(p.ruta, join(carpeta, p.nombre))
        programar(`se subió ${p.nombre}`)
        return json(res, { ok: true, copia })
      }
      if (ruta === '/procesar') {
        programar('pedido desde la página')
        return json(res, { ok: true })
      }
      return json(res, { error: 'No existe' }, 404)
    } catch (e) {
      return json(res, { error: e.message }, 500)
    }
  }

  return { manejar }
}
