// Crea o cambia la contraseña del laboratorio.
//   npm run contrasena                       la pide dos veces, sin mostrarla
//   printf '%s' "$CLAVE" | npm run contrasena --silent    no interactivo (la lee de la entrada)
// Guarda solo el hash (scrypt) en .solar_admin.json, con permisos 600.

import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashContrasena } from './admin.js'

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARCHIVO = join(RAIZ, '.solar_admin.json')
const MINIMO = 8

function preguntarOculto(texto) {
  return new Promise((resolver) => {
    process.stdout.write(texto)
    const entrada = process.stdin
    entrada.setRawMode(true)
    entrada.resume()
    entrada.setEncoding('utf8')
    let valor = ''
    const alTeclear = (tecla) => {
      for (const c of tecla) {
        if (c === '\r' || c === '\n') {
          entrada.setRawMode(false)
          entrada.pause()
          entrada.off('data', alTeclear)
          process.stdout.write('\n')
          return resolver(valor)
        }
        if (c === '\u0003') {
          process.stdout.write('\n')
          process.exit(130)
        }
        if (c === '\u007f' || c === '\b') valor = valor.slice(0, -1)
        else valor += c
      }
    }
    entrada.on('data', alTeclear)
  })
}

async function leerEntrada() {
  let texto = ''
  for await (const trozo of process.stdin) texto += trozo
  return texto.replace(/\r?\n$/, '')
}

let contrasena
if (process.stdin.isTTY) {
  contrasena = await preguntarOculto('Nueva contraseña del laboratorio: ')
  const repetida = await preguntarOculto('Repítala: ')
  if (contrasena !== repetida) {
    console.error('Las contraseñas no coinciden. No se cambió nada.')
    process.exit(1)
  }
} else {
  contrasena = await leerEntrada()
}
if (contrasena.length < MINIMO) {
  console.error(`La contraseña debe tener al menos ${MINIMO} caracteres. No se cambió nada.`)
  process.exit(1)
}

const datos = await hashContrasena(contrasena)
const temporal = `${ARCHIVO}.tmp`
fs.writeFileSync(temporal, JSON.stringify(datos), { mode: 0o600 })
fs.renameSync(temporal, ARCHIVO)
console.log('Contraseña guardada en .solar_admin.json (solo el hash). Las sesiones abiertas siguen activas hasta que expiren.')
