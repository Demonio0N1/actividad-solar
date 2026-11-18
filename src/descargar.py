"""Descarga de datos de actividad solar.

Fuentes:
  - GOES (NOAA/NCEI): catálogo de fulguraciones 1995-hoy, promedios diarios y,
    opcionalmente, datos a 1 minuto.
      GOES-8 a 15  (1995-2020): solo rayos X (XRS). Archivo "legado" de NCEI.
      GOES-16 a 19 (2017-hoy):  rayos X (XRS) y ultravioleta extremo (EUVS), instrumento EXIS.
  - SILSO (Real Observatorio de Bélgica): número de manchas solares diario y mensual
    (oficial, publicado una vez al mes) y la estimación diaria EISN del mes en curso.

Uso:
  python src/descargar.py todo                      # catálogo + diarios + manchas
  python src/descargar.py catalogo
  python src/descargar.py diarios                   # todos los satélites (8 a 19)
  python src/descargar.py diarios --sat 15 16       # solo algunos
  python src/descargar.py manchas
  python src/descargar.py minuto --sat 18 --producto xrs --inicio 2024-05-01 --fin 2024-05-15
  python src/descargar.py minuto --sat 10 --producto xrs --inicio 2003-10-26 --fin 2003-11-06
"""

import argparse
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import requests

from en_vivo import ejecucion, progreso

RAIZ = Path(__file__).resolve().parents[1]
RAW = RAIZ / "data" / "raw"

GOES = "https://data.ngdc.noaa.gov/platforms/solar-space-observing-satellites/goes"
GOES_ANTIGUOS = "https://www.ncei.noaa.gov/data/goes-space-environment-monitor/access/science/xrs"
CATALOGO_DIR = f"{GOES}/multi/l2/data/xrsf-l2-flrpt_science/csv/"

# Años con datos en NCEI (comprobado el 28-09-2026). GOES-R: serie actual con EXIS.
SATELITES_ANTIGUOS = {8: "1995-2003", 9: "1996-1998", 10: "1998-2009", 11: "2006-2008",
                      12: "2003-2007", 13: "2013-2017", 14: "2009-2020", 15: "2010-2020"}
SATELITES_R = {16: "2017-2025", 17: "2018-2023", 18: "2022-hoy", 19: "2024-hoy"}
SATELITES = sorted(SATELITES_ANTIGUOS | SATELITES_R)
# Productos que solo existen en GOES-R
SOLO_GOES_R = {"euvs", "xrs1s"}

# Producto a 1 minuto -> carpeta en el servidor de NCEI
PRODUCTOS_MINUTO = {
    "xrs": "xrsf-l2-avg1m_science",
    "euvs": "euvs-l2-avg1m_science",
    "xrs1s": "xrsf-l2-flx1s_science",
    "flsum": "xrsf-l2-flsum_science",
}
# Productos diarios: un solo archivo por satélite con toda la misión
PRODUCTOS_DIARIOS = {
    "xrs": "xrsf-l2-bkd1d_science",
    "euvs": "euvs-l2-avg1d_science",
}

SILSO = {
    "manchas_diarias.csv": "https://www.sidc.be/SILSO/INFO/sndtotcsv.php",
    "manchas_mensuales.csv": "https://www.sidc.be/SILSO/INFO/snmtotcsv.php",
}
# Estimación diaria (EISN): solo el mes en curso, se actualiza varias veces al día
EISN_URL = "https://www.sidc.be/SILSO/DATA/EISN/EISN_current.csv"

sesion = requests.Session()
sesion.headers["User-Agent"] = "estudio-actividad-solar/1.0 (investigacion academica)"


def bajar(url: str, destino: Path, reemplazar: bool = False) -> Path:
    """Descarga `url` a `destino` con reintentos; omite archivos ya descargados."""
    nombre = str(destino.relative_to(RAIZ))
    if destino.exists() and destino.stat().st_size > 0 and not reemplazar:
        print(f"  ya existe  {nombre}")
        tam = destino.stat().st_size
        progreso(nombre, tam, tam, "ya existía", unidad="bytes")
        return destino
    destino.parent.mkdir(parents=True, exist_ok=True)
    for intento in range(1, 4):
        try:
            with sesion.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                total = int(r.headers.get("Content-Length") or 0) or None
                hecho, ultimo = 0, 0.0
                progreso(nombre, 0, total, "descargando", unidad="bytes")
                tmp = destino.with_suffix(destino.suffix + ".part")
                with open(tmp, "wb") as f:
                    for bloque in r.iter_content(1 << 16):
                        f.write(bloque)
                        hecho += len(bloque)
                        if time.time() - ultimo > 0.15:
                            progreso(nombre, hecho, total, "descargando", unidad="bytes")
                            ultimo = time.time()
                tmp.rename(destino)
                progreso(nombre, hecho, hecho, "listo", unidad="bytes")
            print(f"  descargado {destino.relative_to(RAIZ)} ({destino.stat().st_size / 1e6:.1f} MB)")
            return destino
        except requests.RequestException as e:
            print(f"  intento {intento} falló: {e}", file=sys.stderr)
            progreso(nombre, 0, None, f"reintento {intento}", unidad="bytes")
            time.sleep(2 * intento)
    raise RuntimeError(f"No se pudo descargar {url}")


def carpeta_url(sat: int, carpeta: str) -> str:
    """URL de un producto: GOES-R y los satélites antiguos están en servidores distintos."""
    if sat in SATELITES_R:
        return f"{GOES}/goes{sat}/l2/data/{carpeta}/"
    return f"{GOES_ANTIGUOS}/goes{sat:02d}/{carpeta}/"


def listar(url_dir: str, patron: str) -> list[str]:
    """Nombres de archivo de un listado de directorio HTTP que cumplen `patron`."""
    r = sesion.get(url_dir, timeout=60)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return sorted(set(re.findall(rf'href="({patron})"', r.text)))


def catalogo(reemplazar: bool = True) -> None:
    """Catálogo multi-satélite de fulguraciones (1995-hoy) en un solo CSV."""
    print("Catálogo de fulguraciones GOES")
    nombres = listar(CATALOGO_DIR, r"sci_xrsf-l2-flrpt_geo_s\d{8}_e\d{8}_v[\d-]+\.csv")
    if not nombres:
        raise RuntimeError("No se encontró el catálogo completo en " + CATALOGO_DIR)
    # El nombre cambia a diario (fecha final); se guarda con un nombre fijo
    bajar(CATALOGO_DIR + nombres[-1], RAW / "goes" / "catalogo_fulguraciones.csv", reemplazar)
    bajar(CATALOGO_DIR + "sci_xrsf-l2-flrpt_geo_metadata.json",
          RAW / "goes" / "catalogo_fulguraciones_metadata.json", reemplazar)


def diarios(satelites: list[int] = SATELITES, reemplazar: bool = True) -> None:
    """Promedios diarios de cada satélite: XRS en todos, EUVS solo en GOES-R."""
    print("Promedios diarios GOES: " + ", ".join(f"GOES-{s}" for s in satelites))
    for sat in satelites:
        for clave, carpeta in PRODUCTOS_DIARIOS.items():
            if clave in SOLO_GOES_R and sat not in SATELITES_R:
                continue
            url_dir = carpeta_url(sat, carpeta)
            # Un archivo con toda la misión: ..._g15_s20100407_e20200304_v2-3-0.nc
            nombres = listar(url_dir, rf"sci_[\w-]+_g{sat:02d}_s\d{{8}}_e\d{{8}}_v[\d-]+\.nc")
            if not nombres:
                print(f"  sin datos   GOES-{sat} {clave}")
                continue
            # GOES-8 a 15 ya no operan: su archivo no cambia y no se vuelve a bajar si ya existe
            bajar(url_dir + nombres[-1], RAW / "goes" / "diarios" / f"{clave}_diario_g{sat:02d}.nc",
                  reemplazar and sat in SATELITES_R)


def manchas(reemplazar: bool = True) -> None:
    """Número de manchas solares (SILSO, versión 2) y estimación diaria EISN."""
    print("Número de manchas solares (SILSO)")
    for nombre, url in SILSO.items():
        bajar(url, RAW / "silso" / nombre, reemplazar)
    acumular_eisn(bajar(EISN_URL, RAW / "silso" / "eisn_mes_actual.csv", reemplazar))


def acumular_eisn(actual: Path) -> None:
    """Suma el EISN recién bajado a data/raw/silso/eisn_acumulado.csv.

    EISN_current.csv solo trae el mes en curso: al empezar un mes nuevo desaparecen los
    días del anterior, y SILSO tarda unos días en publicar sus valores oficiales. Al
    acumular no se pierden. Si un día aparece dos veces, gana el valor más reciente.
    Columnas: año, mes, día, año decimal, EISN, desviación, estaciones usadas, estaciones disponibles.
    """
    acumulado = RAW / "silso" / "eisn_acumulado.csv"
    filas: dict[tuple[int, int, int], str] = {}
    for ruta in (acumulado, actual):
        if not ruta.exists():
            continue
        for linea in ruta.read_text().splitlines():
            c = [x.strip() for x in linea.split(",")]
            if len(c) >= 8 and c[0].isdigit():
                filas[(int(c[0]), int(c[1]), int(c[2]))] = ",".join(c[:8])
    if not filas:
        return
    acumulado.write_text("\n".join(filas[k] for k in sorted(filas)) + "\n")
    a, m, d = max(filas)
    print(f"  EISN acumulado: {len(filas)} días, hasta {a}-{m:02d}-{d:02d}")


def minuto(sat: int, producto: str, inicio: date, fin: date) -> None:
    """Archivos diarios de alta cadencia para un rango de fechas."""
    if producto in SOLO_GOES_R and sat not in SATELITES_R:
        raise SystemExit(f"El producto '{producto}' solo existe en GOES-16 a 19; GOES-{sat} solo tiene XRS.")
    carpeta = PRODUCTOS_MINUTO[producto]
    print(f"GOES-{sat} {carpeta} {inicio} -> {fin}")
    listados: dict[str, list[str]] = {}
    dia = inicio
    while dia <= fin:
        url_dir = f"{carpeta_url(sat, carpeta)}{dia:%Y/%m}/"
        if url_dir not in listados:
            listados[url_dir] = listar(url_dir, r"sci_[\w-]+\.nc")
        candidatos = [n for n in listados[url_dir] if f"_d{dia:%Y%m%d}_" in n]
        if candidatos:
            bajar(url_dir + candidatos[-1], RAW / "goes" / carpeta / f"g{sat:02d}" / candidatos[-1])
        else:
            print(f"  sin archivo {dia}")
        dia += timedelta(days=1)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for cmd in ("todo", "diarios"):
        sub.add_parser(cmd).add_argument("--sat", type=int, nargs="+", choices=SATELITES, default=SATELITES,
                                         metavar="N", help="satélites GOES (8 a 19); por defecto, todos")
    sub.add_parser("catalogo")
    sub.add_parser("manchas")
    sub.add_parser("satelites", help="lista los satélites disponibles y sus años")
    m = sub.add_parser("minuto")
    m.add_argument("--sat", type=int, choices=SATELITES, required=True, metavar="N")
    m.add_argument("--producto", choices=PRODUCTOS_MINUTO, default="xrs")
    m.add_argument("--inicio", type=date.fromisoformat, required=True)
    m.add_argument("--fin", type=date.fromisoformat, required=True)
    a = p.parse_args()

    if a.cmd == "satelites":
        for sat in SATELITES:
            tipo = "XRS + EUVS (GOES-R)" if sat in SATELITES_R else "XRS"
            print(f"GOES-{sat:<3} {(SATELITES_R | SATELITES_ANTIGUOS)[sat]:<10} {tipo}")
        return

    with ejecucion("descargar", {k: str(v) for k, v in vars(a).items()}):
        if a.cmd in ("todo", "catalogo"):
            catalogo()
        if a.cmd in ("todo", "diarios"):
            diarios(a.sat)
        if a.cmd in ("todo", "manchas"):
            manchas()
        if a.cmd == "minuto":
            minuto(a.sat, a.producto, a.inicio, a.fin)


if __name__ == "__main__":
    main()
