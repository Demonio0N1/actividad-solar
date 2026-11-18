// Laboratorio con contraseña: sesión, y correr / detener / publicar modelos.
//
// La contraseña se guarda solo como hash scrypt en .solar_admin.json (permisos 600). Se crea con
// `npm run contrasena` o `./setup_sun.sh contrasena`. Sin ese archivo, el laboratorio está cerrado.
//
//   POST /api/admin/entrar      { contrasena }            → cookie de sesión (12 h)
//   POST /api/admin/salir
//   GET  /api/admin/sesion                                → { activa, configurada }
//   GET  /api/admin/modelos                               catálogo (src/modelos/catalogo.py)
//   POST /api/admin/validar     { modelo, parametros }    → errores y ecuación en LaTeX
//   POST /api/admin/correr      { modelo, parametros }    → corre en segundo plano (una a la vez)
//   POST /api/admin/detener
//   POST /api/admin/publicar    { corrida }               → muestra esa corrida en la página pública
//   POST /api/admin/actualizar                            → descarga y procesa los datos ahora
//   GET  /api/admin/corridas                              últimas corridas guardadas
//   GET  /api/admin/corrida?id=…                          una corrida completa

import { execFile, spawn } from 'node:child_process'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const PARAMETROS_SCRYPT = { N: 16384, r: 8, p: 1 }
const DURACION_SESION_MS = 12 * 60 * 60 * 1000
const MAX_INTENTOS = 5 // por visitante, cada 10 minutos
const VENTANA_INTENTOS_MS = 10 * 60 * 1000
const LIMITE_CORRIDA_MS = 3 * 60 * 1000
const COOKIE = 'solar_sesion'

export async function hashContrasena(contrasena) {
  const sal = randomBytes(16)
  const hash = await scryptAsync(contrasena, sal, 64, PARAMETROS_SCRYPT)
  return { algoritmo: 'scrypt', ...PARAMETROS_SCRYPT, sal: sal.toString('base64'), hash: hash.toString('base64') }
}

function json(res, datos, estado = 200, cabeceras = {}) {
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabeceras })
  res.end(JSON.stringify(datos))
}

function leerCuerpo(req, maximo = 64 * 1024) {
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

const visitante = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  )
}

// Las cookies "Secure" solo viajan por HTTPS: se usan si la página llega por HTTPS (nginx con
// certificado, Tailscale Serve/Funnel), y no en http://IP:8080 o en desarrollo.
const esHttps = (req) =>
  req.headers['x-forwarded-proto'] === 'https' || /\.ts\.net(:\d+)?$/.test(String(req.headers.host || ''))

/** Rechaza peticiones que no vienen de la propia página (protección CSRF junto con SameSite=Strict). */
function mismoOrigen(req) {
  const origen = req.headers.origin
  if (!origen) return true
  try {
    return new URL(origen).host === req.headers.host
  } catch {
    return false
  }
}

export function crearAdmin(raiz, { difundirAdmin }) {
  const archivo = join(raiz, '.solar_admin.json')
  const python = join(raiz, '.venv', 'bin', 'python')
  const correrPy = join(raiz, 'src', 'modelos', 'correr.py')
  const sesiones = new Map()
  const intentos = new Map()
  let proceso = null // corrida o actualización en curso
  let catalogo = null

  function configurada() {
    return fs.existsSync(archivo)
  }

  async function verificar(contrasena) {
    let datos
    try {
      datos = JSON.parse(fs.readFileSync(archivo, 'utf8'))
    } catch {
      return false
    }
    const esperado = Buffer.from(datos.hash, 'base64')
    const calculado = await scryptAsync(String(contrasena), Buffer.from(datos.sal, 'base64'), esperado.length, {
      N: datos.N, r: datos.r, p: datos.p,
    })
    return timingSafeEqual(calculado, esperado)
  }

  function sesionValida(req) {
    const id = cookies(req)[COOKIE]
    if (!id) return false
    const expira = sesiones.get(id)
    if (!expira || expira < Date.now()) {
      sesiones.delete(id)
      return false
    }
    return true
  }

  function demasiadosIntentos(req) {
    const ahora = Date.now()
    const quien = visitante(req)
    const recientes = (intentos.get(quien) || []).filter((t) => ahora - t < VENTANA_INTENTOS_MS)
    intentos.set(quien, recientes)
    return recientes.length >= MAX_INTENTOS
  }

  function ejecutarPython(args, { timeout = 20000 } = {}) {
    return new Promise((resolver, rechazar) => {
      execFile(python, [correrPy, ...args], { cwd: raiz, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, salida, errores) => {
        if (err) return rechazar(new Error((errores || err.message).trim().split('\n').pop()))
        try {
          resolver(JSON.parse(salida))
        } catch {
          rechazar(new Error('Respuesta inválida de correr.py'))
        }
      })
    })
  }

  /** Lanza un proceso largo (modelo o actualización); una sola cosa a la vez. */
  function lanzar(nombre, comando, args) {
    if (proceso) return { error: `Ya hay algo corriendo: ${proceso.nombre}. Espere o deténgalo.` }
    const hijo = spawn(comando, args, { cwd: raiz, stdio: ['ignore', 'pipe', 'pipe'] })
    proceso = { nombre, hijo, inicio: Date.now() }
    let errores = ''
    hijo.stderr.on('data', (t) => (errores = (errores + t).slice(-4000)))
    hijo.stdout.resume()
    const limite = setTimeout(() => hijo.kill('SIGTERM'), nombre === 'modelo' ? LIMITE_CORRIDA_MS : 20 * 60 * 1000)
    hijo.on('close', (codigo, senal) => {
      clearTimeout(limite)
      proceso = null
      difundirAdmin('solar:proceso', { nombre, codigo, senal, error: codigo ? errores.trim().split('\n').pop() : null })
    })
    hijo.on('error', (e) => {
      clearTimeout(limite)
      proceso = null
      difundirAdmin('solar:proceso', { nombre, codigo: -1, error: e.message })
    })
    difundirAdmin('solar:proceso', { nombre, inicio: proceso.inicio, corriendo: true })
    return { ok: true }
  }

  function listarCorridas() {
    const dir = join(raiz, 'data', 'modelos', 'corridas')
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        try {
          const c = JSON.parse(fs.readFileSync(join(dir, n), 'utf8'))
          return { id: c.id, modelo: c.modelo, nombre: c.nombre, fecha: c.fecha, parametros: c.parametros, resumen: c.resumen }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
      .slice(0, 30)
  }

  async function manejar(req, res, ruta) {
    // Sesión
    if (ruta === '/sesion') return json(res, { activa: sesionValida(req), configurada: configurada(), corriendo: proceso?.nombre ?? null })
    if (req.method === 'POST' && !mismoOrigen(req)) return json(res, { error: 'Origen no permitido' }, 403)

    if (ruta === '/entrar' && req.method === 'POST') {
      if (!configurada()) return json(res, { error: 'El laboratorio no tiene contraseña. En el servidor: ./setup_sun.sh contrasena' }, 503)
      if (demasiadosIntentos(req)) return json(res, { error: 'Demasiados intentos. Espere 10 minutos.' }, 429)
      let datos
      try {
        datos = await leerCuerpo(req)
      } catch (e) {
        return json(res, { error: e.message }, 400)
      }
      if (!(await verificar(datos.contrasena || ''))) {
        intentos.get(visitante(req)).push(Date.now())
        return json(res, { error: 'Contraseña incorrecta.' }, 401)
      }
      intentos.delete(visitante(req))
      const id = randomBytes(32).toString('base64url')
      sesiones.set(id, Date.now() + DURACION_SESION_MS)
      const seguro = esHttps(req) ? '; Secure' : ''
      return json(res, { ok: true }, 200, {
        'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DURACION_SESION_MS / 1000}${seguro}`,
      })
    }
    if (ruta === '/salir' && req.method === 'POST') {
      sesiones.delete(cookies(req)[COOKIE])
      return json(res, { ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
    }

    // A partir de aquí, todo requiere sesión
    if (!sesionValida(req)) return json(res, { error: 'Inicie sesión' }, 401)

    try {
      if (ruta === '/modelos' && req.method === 'GET') {
        catalogo ??= await ejecutarPython(['--listar'])
        return json(res, catalogo)
      }
      if (ruta === '/corridas' && req.method === 'GET') return json(res, listarCorridas())
      if (ruta === '/corrida' && req.method === 'GET') {
        const id = new URL(req.url, 'http://x').searchParams.get('id') || ''
        if (!/^[A-Za-z0-9]{6,40}$/.test(id)) return json(res, { error: 'Corrida inválida' }, 400)
        const archivoCorrida = join(raiz, 'data', 'modelos', 'corridas', `${id}.json`)
        if (!fs.existsSync(archivoCorrida)) return json(res, { error: 'No existe' }, 404)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        return fs.createReadStream(archivoCorrida).pipe(res)
      }
      if (req.method !== 'POST') return json(res, { error: 'No existe' }, 404)

      const datos = await leerCuerpo(req)
      if (ruta === '/validar') {
        return json(res, await ejecutarPython(['--validar', '--modelo', String(datos.modelo), '--parametros', JSON.stringify(datos.parametros || {})]))
      }
      if (ruta === '/correr') {
        const v = await ejecutarPython(['--validar', '--modelo', String(datos.modelo), '--parametros', JSON.stringify(datos.parametros || {})])
        if (!v.ok) return json(res, { error: 'Parámetros inválidos', errores: v.errores }, 400)
        const r = lanzar('modelo', python, [correrPy, '--modelo', String(datos.modelo), '--parametros', JSON.stringify(v.parametros)])
        return json(res, r, r.error ? 409 : 202)
      }
      if (ruta === '/detener') {
        if (!proceso) return json(res, { error: 'No hay nada corriendo' }, 409)
        proceso.hijo.kill('SIGTERM')
        return json(res, { ok: true })
      }
      if (ruta === '/publicar') {
        if (!/^[A-Za-z0-9]{6,40}$/.test(String(datos.corrida))) return json(res, { error: 'Corrida inválida' }, 400)
        await new Promise((resolver, rechazar) =>
          execFile(python, [correrPy, '--publicar-corrida', datos.corrida], { cwd: raiz, timeout: 20000 }, (err, _o, e) =>
            err ? rechazar(new Error((e || err.message).trim().split('\n').pop())) : resolver(),
          ),
        )
        return json(res, { ok: true })
      }
      if (ruta === '/actualizar') {
        const r = lanzar('actualizar', 'npm', ['run', 'actualizar'])
        return json(res, r, r.error ? 409 : 202)
      }
      return json(res, { error: 'No existe' }, 404)
    } catch (e) {
      return json(res, { error: e.message }, 500)
    }
  }

  return { manejar, sesionValida }
}
