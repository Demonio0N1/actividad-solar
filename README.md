# Monitoreo del Sol en vivo

Sitio web y análisis de la actividad solar de 1995 a hoy (ciclos 23, 24 y 25) con rayos X y
ultravioleta extremo del GOES, número de manchas SILSO e imágenes de SOHO/SDO, más cuatro modelos
del ciclo solar que se corren y modifican desde un laboratorio con contraseña.

El plan de investigación (objetivos, fases, IA, cronograma) es privado: `plan_proyecto.html`
en esta carpeta, y la página publicada en claude.ai. No forma parte del sitio.

## Puesta en marcha

Requiere Python 3.10+ y Node 20+. Una sola vez:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm install
npm run contrasena   # contraseña del laboratorio (mínimo 8 caracteres)
```

## El sitio

```bash
npm run dev          # en su computador: http://localhost:5173
```

| Página | Para quién | Qué tiene |
|---|---|---|
| **En vivo** (`/`) | público | El Sol de cualquier día desde 1996, manchas y fulguraciones por mes, diagrama mariposa observado, el **modelo publicado** y las figuras. Se recarga sola cuando cambian los datos. |
| **Modelo** (`/modelo`) | público | La física, las ecuaciones y el código de los modelos, con referencias. |
| **Meteorología** (`/meteorologia`) | público | Red de estaciones del OAQ (datos de `Metorologia/*.parquet`): **Panel** (estado de la red y última medición de cada estación, últimas 72 h), **Explorador** (estaciones, variables, fechas, horas y resolución; gráficos, tabla y descarga CSV) y **Calidad y eventos** (marcas, correcciones no documentadas, periodo de prueba). |
| **Laboratorio** (`/laboratorio`) | con contraseña | Elegir y modificar modelos, correrlos viendo la simulación en vivo, publicar un resultado, actualizar los datos a mano, ver las ejecuciones y la consola. |

La descarga, el procesamiento, las figuras y el modelo publicado corren **solos una vez al día**
(`npm run diario`, que en el servidor lanza un temporizador de systemd). La página pública
muestra los resultados; la salida de los scripts solo se ve en el laboratorio.

### Laboratorio

- **Modelos:** 1 dínamo αΩ de Parker, 2 con fluctuaciones en α, 3 transporte de flujo en dos
  capas, 4 oscilador de Van der Pol (comparado con las manchas desde 1749). Están descritos en
  `/modelo`, sección 8, y definidos en `src/modelos/catalogo.py`.
- **Modificar la ecuación:** el perfil α(θ) y la forma de la corriente v(θ) se escriben como
  fórmulas (por ejemplo `cos(t)*sin(t)^4`), y el quenching, el término Ω, el laplaciano y la
  paridad se eligen de una lista. La ecuación resultante se muestra en LaTeX mientras escribe.
- **Seguridad de las fórmulas:** solo se aceptan números, θ (`t`), λ (`lat`), `pi`, `e`,
  operadores y funciones matemáticas (`src/modelos/expresiones.py`); no se puede ejecutar código.
- **Límites:** cada parámetro tiene un rango que mantiene una corrida por debajo de ~1 minuto en
  una Raspberry Pi 5, y hay una corrida a la vez (máximo 3 minutos).
- **Publicar:** copia el resultado a `data/processed/modelo_publicado.json`, que es lo que ve el
  público, y guarda la configuración en `data/modelos/publicado.json` para que la actualización
  diaria la repita. Las corridas se guardan en `data/modelos/corridas/` (las 50 últimas).
- **Contraseña:** `npm run contrasena` (o `./setup_sun.sh contrasena` en el servidor). Solo se
  guarda su hash scrypt en `.solar_admin.json`. Hay un máximo de 5 intentos fallidos cada 10
  minutos y la sesión dura 12 horas.
- Desde la terminal: `npm run modelo -- --modelo estocastico --parametros '{"ruido": 0.8}'`.

### Scripts y comandos

| Comando | Qué hace |
|---|---|
| `npm run diario` | descargar + procesar + figuras + `modelo_dinamo.py` + modelo publicado |
| `npm run actualizar` | descargar + procesar + figuras |
| `npm run modelo` | correr un modelo del laboratorio desde la terminal |
| `npm run dinamo` | el dínamo αΩ original (`src/modelo_dinamo.py`, figura 5) |

Cómo funciona por dentro: `src/en_vivo.py` envía los eventos de cada script a
`POST /api/eventos` (con un token si existe `.solar_vivo.json`). El servidor
(`web/servidor/api.js`) los reenvía por Server-Sent Events solo al laboratorio
(`/api/admin/stream`); el canal público (`/api/stream`) solo avisa de figuras y tablas nuevas.

### Actualizar los datos

```bash
npm run actualizar   # = descargar + procesar + explorar (~20 MB)
```

En el servidor no hace falta: corre solo cada día. También está el botón "Actualizar datos ahora"
en el laboratorio. Al terminar, los gráficos y figuras de la página se recargan solos.
Hasta dónde llega cada fuente después de actualizar:

- Catálogo de fulguraciones y promedios diarios GOES: hasta ayer o anteayer.
- Número de manchas diario: el valor oficial de SILSO llega hasta el último día del **mes
  anterior**, porque se publica una vez al mes. Los días siguientes, hasta hoy, se completan con la
  **estimación diaria EISN** de SILSO (columna `fuente = EISN` en `manchas_diarias.csv`). El valor
  de hoy cambia durante el día a medida que reportan más estaciones.
- EISN solo se publica para el mes en curso, así que cada descarga lo acumula en
  `data/raw/silso/eisn_acumulado.csv`. Así no se pierden los días del mes anterior mientras SILSO
  publica los oficiales. Cuando llegan los oficiales, reemplazan a la estimación.

### El Sol ese día

En la página en vivo, la sección **El Sol ese día** muestra el disco solar de cualquier fecha desde el
19-05-1996: en luz visible (manchas) o como magnetograma. Las imágenes vienen del archivo de SOHO
(`soho.nascom.nasa.gov/data/REPROCESSING/Completed/`): SOHO/MDI hasta el 11-01-2011 y SDO/HMI desde
el 01-01-2011, unas 16 por día.

- **Mostrar imagen** busca las del día elegido (por defecto la más cercana a las 12:00 UT); el
  selector de hora permite ver las demás, y ◀ ▶ cambian de día.
- **Ahora, en vivo** muestra la más reciente y busca una nueva cada 10 minutos. Así abre la página.
- **Guardar imagen** la descarga como `sol_continuo_AAAAMMDD_HHMMUT.jpg`. Además, cada imagen que
  se ve queda guardada en `data/raw/sol/AAAA/`.
- Junto a la imagen aparecen el número de manchas SILSO y las fulguraciones de ese día (de las
  tablas procesadas).
- Un clic sobre una fulguración del diagrama mariposa observado abre el Sol de ese día a esa hora.
- No hay imágenes entre el 24-06-1998 y el 20-10-1998 (SOHO perdió contacto) ni en algunos días sueltos.

`plan_proyecto.html` es una copia del plan que se abre sin servidor (doble clic).

## Actualizar desde GitHub

El código está en GitHub; los datos (`data/`, `figuras/`, `Metorologia/`) y la contraseña del
laboratorio no van en el repositorio: cada servidor tiene los suyos.

En un servidor nuevo: `git clone` del repositorio y `./setup_sun.sh instalar`. En un servidor que ya
tenía el proyecto copiado (por ejemplo, la Raspberry), se convierte la carpeta en repositorio una sola
vez, sin perder datos ni contraseña:

```bash
cd ~/actividad_solar
git init -b main
git remote add origin https://github.com/Demonio0N1/actividad-solar.git
git fetch origin
git reset --hard origin/main     # reemplaza solo los archivos del código
git branch --set-upstream-to=origin/main main
```

Desde entonces, cada actualización es:

```bash
./setup_sun.sh actualizar-codigo   # git pull, dependencias nuevas si las hay, recompilar y reiniciar
```

Los datos meteorológicos nuevos no pasan por git: se suben en **Meteorología → Datos** (con la
contraseña del laboratorio) o se copian a `Metorologia/`. En ambos casos la página los procesa sola.

## Llevarlo a un servidor

`setup_sun.sh` empaqueta el proyecto y lo instala en un servidor Linux (Ubuntu/Debian o
Fedora/RHEL/Rocky) como servicio:

```bash
# en su computador
./setup_sun.sh empaquetar                      # → actividad_solar_AAAAMMDD.tar.gz (~40 MB)
scp actividad_solar_*.tar.gz usuario@servidor:~

# en el servidor, como usuario normal con sudo
mkdir actividad_solar && tar xzf actividad_solar_*.tar.gz -C actividad_solar
cd actividad_solar
./setup_sun.sh instalar                        # página en http://IP:8080
./setup_sun.sh instalar --dominio sol.ejemplo.org   # o con nginx en el puerto 80
```

Qué hace `instalar`: instala Python ≥ 3.10 y Node 22 si faltan, crea `.venv` y `node_modules`,
genera el token de `.solar_vivo.json`, pide la contraseña del laboratorio (si no hay terminal,
genera una y la muestra una vez), descarga los datos si faltan, compila la página (`dist/`) y crea
tres unidades de systemd:

- `actividad-solar.service`: la página (`npm start`, `web/servidor/produccion.js`).
- `actividad-solar-actualizar.timer`: corre `npm run diario` cada día a las 06:30 UTC
  (`--hora` la cambia): datos, figuras y modelo publicado. Se ve en vivo en el laboratorio.
- con `--dominio`, un sitio de nginx que pasa todo al puerto local y bloquea `/api/eventos`
  desde afuera. Para HTTPS: `sudo certbot --nginx -d DOMINIO`.

### Raspberry Pi con Tailscale

Probado en Debian 12 ARM64, la base de Raspberry Pi OS de 64 bits. Use el sistema de 64 bits,
que es el que trae por defecto el Pi 5. Con Tailscale ya conectado (`sudo tailscale up`):

```bash
./setup_sun.sh instalar --tailscale
```

La página queda en `https://NOMBRE-DEL-PI.SU-RED.ts.net`, con HTTPS y visible solo para los equipos
de su red Tailscale; el puerto 8080 no se abre en la red local. Hace falta tener activados MagicDNS
y los certificados HTTPS de la red (https://login.tailscale.com/admin/dns).

Para que sea **pública en internet** (sin Tailscale en el teléfono o computador de quien la abre),
use `./setup_sun.sh instalar --funnel`. Es la misma dirección, servida con Tailscale Funnel. Volver
a ejecutar la instalación con `--funnel` mantiene la página pública; con `--tailscale` la vuelve
privada. Sin `--tailscale` también funciona, en
`http://NOMBRE-DEL-PI:8080` (por Tailscale y por la red local).

Otros comandos: `./setup_sun.sh estado | actualizar | contrasena | reiniciar | desinstalar`. Después de
copiar código nuevo al servidor, `./setup_sun.sh reiniciar` recompila y reinicia la página.

### Seguridad en un servidor público

- Solo los scripts del propio servidor pueden enviar eventos a la página: necesitan el token
  de `.solar_vivo.json` (permisos 600; no se incluye al empaquetar).
- Cada visitante puede pedir como máximo 60 imágenes del Sol *nuevas* cada 10 minutos
  (`SOLAR_LIMITE_IMAGENES`); las ya guardadas en `data/raw/sol/` se sirven sin límite.
- Solo se sirven archivos `.png` de `figuras/` y `.csv`/`.json` de `data/processed/`.

### Desarrollo y producción

| | `npm run dev` | `npm start` (tras `npm run build`) |
|---|---|---|
| Para qué | trabajar en su computador | el servidor |
| Puerto | 5173 | 8080 (`PORT`) |
| Recarga al editar código | sí | no: `npm run build` y reiniciar |
| Página en vivo, API, imágenes del Sol | sí | sí (misma API, `web/servidor/api.js`) |

## Scripts de Python

```bash
.venv/bin/python src/descargar.py todo     # ~30 MB: catálogo de fulguraciones, diarios GOES-8 a 19, manchas
.venv/bin/python src/procesar.py           # genera las tablas en data/processed/
.venv/bin/python src/explorar.py           # figuras 1-4 en figuras/
.venv/bin/python src/modelo_dinamo.py      # figura 5: diagrama mariposa simulado
.venv/bin/python src/meteorologia.py       # estaciones del OAQ: Metorologia/*.parquet -> data/processed/meteo/
```

`src/meteorologia.py` no modifica los Parquet: marca los valores anómalos (fuera de especificación,
fuera por corrección, sospechosos, horas y registros repetidos, periodo de prueba) y genera los agregados
por hora y por día con la agregación de cada variable. Los eventos conocidos (correcciones no documentadas,
periodo de prueba de Carapungo) están en la lista `EVENTOS` del script.

Satélites: `python src/descargar.py satelites` muestra los 12 disponibles y sus años. Por defecto se
descargan todos; para elegir, `python src/descargar.py diarios --sat 15 16 18`. GOES-8 a 15 solo tienen
rayos X (XRS); el ultravioleta extremo (EUVS) y el XRS a 1 segundo existen solo en GOES-16 a 19.

Datos de alta cadencia, solo para los periodos que se necesiten (cada día de XRS pesa ~0.3 MB,
cada día de EUVS ~3.3 MB):

```bash
.venv/bin/python src/descargar.py minuto --sat 18 --producto xrs --inicio 2024-05-01 --fin 2024-05-15
```

## Estructura

```
data/raw/          datos originales, tal como se descargan (no se editan)
data/raw/sol/      imágenes del Sol vistas en la página, por año
data/processed/    tablas limpias en CSV
figuras/           gráficos generados por los scripts
web/               sitio (Vite): index.html, modelo.html, laboratorio.html, src/, vite.config.js
web/servidor/      api.js (API común), admin.js (laboratorio), sol.js (imágenes del Sol),
                   produccion.js (npm start), contrasena.js (npm run contrasena)
setup_sun.sh       empaqueta e instala el proyecto en un servidor Linux
src/
  en_vivo.py       envía el progreso de los scripts a la página
  descargar.py     descarga desde NOAA/NCEI y SILSO
  procesar.py      NetCDF/CSV crudos -> tablas limpias
  explorar.py      figuras exploratorias
  modelo_dinamo.py dínamo αΩ 1D (onda de Parker), el documentado en /modelo
  modelos/         modelos del laboratorio: catalogo.py, latitud.py, vanderpol.py,
                   expresiones.py (fórmulas seguras), correr.py
data/modelos/      corridas del laboratorio y configuración del modelo publicado
notebooks/         análisis interactivos (fases 3-5)
```

## Datos

| Tabla (`data/processed/`) | Contenido | Periodo |
|---|---|---|
| `fulguraciones.csv` | 81,526 fulguraciones: inicio/pico/fin, clase, flujo pico, fluencia, latitud/longitud, región activa | 1995 – hoy |
| `goes_diario_compuesto.csv` | Mediana diaria entre satélites: XRS-A/B (promedio y fondo) desde 1995; 7 líneas EUV e índice Mg II desde 2017 | 1995 – hoy |
| `goes_diario.csv` | Lo mismo, separado por satélite (GOES-8 a 19) | 1995 – hoy |
| `manchas_diarias.csv`, `manchas_mensuales.csv` | Número de manchas SILSO v2 (mensual con media móvil de 13 meses). Diario: columna `fuente` = `SILSO` (oficial) o `EISN` (estimación del mes en curso) | 1818 / 1749 – hoy |
| `indices_mensuales.csv` | Conteo mensual de fulguraciones C, M, X + manchas + XRS + EUV | 1995 – hoy |

Fuentes:
- GOES-R EXIS, GOES-16 a 19 (XRS y EUVS): https://www.ncei.noaa.gov/products/goes-r-extreme-ultraviolet-xray-irradiance
- GOES-8 a 15 (solo XRS): https://www.ncei.noaa.gov/data/goes-space-environment-monitor/access/science/xrs/
- SOHO: https://soho.nascom.nasa.gov/data/archive/ (descarga vía https://ssa.esac.esa.int/ssa/ o VSO/`sunpy`)
- SILSO: https://www.sidc.be/SILSO/

### Precauciones con los datos

- **Solo el 38% de las fulguraciones tiene posición.** Los análisis por latitud usan ese subconjunto.
- **Eventos saturados:** 4 fulguraciones (2001-04-02, 2003-10-28, 2003-11-04, 2005-09-07) saturaron
  el detector de GOES-8/12 cerca de X24 (`peak_saturated = 1`); su flujo pico real fue mayor.
  La del 4 de noviembre de 2003 se estimó en ~X28 en la escala antigua de NOAA (≈X40 en la escala
  actual, que eliminó el factor 0.7 de los GOES anteriores al 16).
- **Cambio de satélite:** cada GOES tiene su calibración. `goes_diario_compuesto.csv` usa la mediana
  entre satélites para suavizar los saltos, pero para análisis finos conviene comparar satélite por satélite.
- **Completitud:** por debajo de ~C2 (2×10⁻⁶ W/m²) el catálogo pierde eventos en el máximo solar, porque
  el fondo de rayos X alto tapa las fulguraciones pequeñas.
- **Satélites antiguos frente a GOES-R:** en los 514 días en que GOES-15 y GOES-16 midieron a la vez,
  GOES-16 da en mediana un 9% más de flujo XRS-B (p10–p90: 0.88–1.41). NOAA ya quitó el antiguo factor
  0.7, pero para series largas conviene intercalibrar (línea D de IA en el plan).
- **Huecos:** con los 12 satélites falta XRS en 64 de 11,587 días (1995–2026), sobre todo del
  17 al 31 de enero y del 1 al 20 de marzo de 2008.
- **Banderas de calidad:** `procesar.py` conserva solo datos diarios con bandera 0 (`good_data`).

## Primeros resultados

- La distribución del flujo pico sigue una ley de potencia con α = 2.05 ± 0.01 (por encima de C2),
  consistente con la literatura (~1.8–2.1).
- La latitud de las fulguraciones reproduce el diagrama mariposa (ley de Spörer) en los tres ciclos.
- El modelo de dínamo con D = −2000 produce ondas que migran de ~54° a ~16°, con polaridad opuesta
  en cada hemisferio (ley de Hale) y ciclos asimétricos (subida rápida, bajada lenta).
