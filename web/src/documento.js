// Páginas de texto (Modelo): recarga las figuras cuando se vuelven a generar.
import { alCambiarArchivo, indicadorConexion } from './comun.js'

indicadorConexion()

alCambiarArchivo(({ url, mtime }) => {
  if (!mtime) return
  for (const img of document.querySelectorAll(`img[src^="${url}"]`)) {
    img.src = `${url}?v=${Math.round(mtime)}`
    const figura = img.closest('figure')
    figura?.classList.add('actualizada')
    setTimeout(() => figura?.classList.remove('actualizada'), 2500)
  }
})
