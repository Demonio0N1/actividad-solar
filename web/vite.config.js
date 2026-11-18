// Configuración de Vite.
//   npm run dev    servidor de desarrollo en http://localhost:5173 (recarga al editar)
//   npm run build  compila la página en dist/ para el servidor de producción (npm start)
//
// La API de la página en vivo (eventos de Python, imágenes del Sol, figuras y tablas)
// está en servidor/api.js y es la misma en desarrollo y en producción.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { crearApi } from './servidor/api.js'

const WEB = dirname(fileURLToPath(import.meta.url))
const RAIZ = resolve(WEB, '..')

function solarEnVivo() {
  return {
    name: 'solar-en-vivo',
    configureServer(server) {
      server.middlewares.use(crearApi(RAIZ))
    },
  }
}

export default defineConfig({
  root: WEB,
  appType: 'mpa', // varias páginas: /, /modelo, /meteorologia, /laboratorio
  plugins: [solarEnVivo()],
  server: {
    port: 5173,
    strictPort: true, // los scripts de Python envían a este puerto
    open: '/',
  },
  build: {
    outDir: resolve(RAIZ, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        vivo: resolve(WEB, 'index.html'),
        modelo: resolve(WEB, 'modelo.html'),
        meteorologia: resolve(WEB, 'meteorologia.html'),
        laboratorio: resolve(WEB, 'laboratorio.html'),
      },
    },
  },
})
