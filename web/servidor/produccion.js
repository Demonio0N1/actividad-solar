// Servidor de producción: sirve la página compilada (dist/, generada con `npm run build`)
// y la API de servidor/api.js. Sin dependencias fuera de Node.
//
//   npm start                     escucha en 0.0.0.0:8080
//   PORT=3000 HOST=127.0.0.1 npm start
//
// Detrás de nginx conviene HOST=127.0.0.1 (solo nginx llega al puerto). setup_sun.sh
// lo configura como servicio de systemd.

import fs from 'node:fs'
import http from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crearApi } from './api.js'

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = join(RAIZ, 'dist')
const PUERTO = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

if (!fs.existsSync(join(DIST, 'index.html'))) {
  console.error(`No existe ${DIST}/index.html. Compile la página primero: npm run build`)
  process.exit(1)
}

function estatico(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    return res.end()
  }
  let url
  try {
    url = decodeURIComponent((req.url || '/').split('?')[0])
  } catch {
    res.statusCode = 400
    return res.end()
  }
  if (url === '/') url = '/index.html'
  // /modelo y /laboratorio sin extensión también funcionan
  if (!extname(url) && fs.existsSync(join(DIST, `${url}.html`))) url = `${url}.html`
  const ruta = resolve(DIST, `.${url}`)
  if (!ruta.startsWith(DIST + sep)) {
    res.statusCode = 403
    return res.end()
  }
  fs.stat(ruta, (err, st) => {
    if (err || !st.isFile()) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end('<!doctype html><meta charset="utf-8"><title>No encontrado</title><p>Página no encontrada. <a href="/">Volver al inicio</a>.</p>')
    }
    res.setHeader('Content-Type', TIPOS[extname(ruta)] || 'application/octet-stream')
    // Los archivos de assets/ llevan un hash en el nombre: se pueden guardar en caché para siempre
    res.setHeader('Cache-Control', url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(ruta).pipe(res)
  })
}

const api = crearApi(RAIZ)
const servidor = http.createServer((req, res) => api(req, res, () => estatico(req, res)))
servidor.listen(PUERTO, HOST, () => {
  console.log(`Monitoreo del Sol en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PUERTO}`)
})

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    servidor.close()
    process.exit(0)
  })
}
