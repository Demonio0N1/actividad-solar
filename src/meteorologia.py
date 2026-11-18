"""Prepara los datos de las estaciones meteorológicas del OAQ para la pestaña "Meteorología".

Entrada (no se modifica): un Parquet por estación en Metorologia/<tabla>.parquet, una fila cada ~5 min,
con la hora local de Ecuador (UTC−5) en la columna `tiempo`.

Salidas, en data/processed/meteo/ (todas se regeneran desde los Parquet):
  estaciones.json            catálogo de variables, eventos, estado y calidad de cada estación
  reciente.csv               últimas 72 h de la red, cada 5 min (solo valores sin marca)
  5min/<tabla>/<AAAA-MM>.csv todos los registros, con `id`, `tiempo` y sus marcas de calidad
  hora/<tabla>.csv           agregados por hora sin valores marcados   (…_todos.csv: con marcados)
  dia/<tabla>.csv            agregados por día sin valores marcados    (…_todos.csv: con marcados)

Reglas (documento "Plataforma web de información meteorológica del OAQ", 18 nov 2026):
  - Unidades OMM; las estaciones activas ya guardan en esas unidades: no se convierte nada.
  - Los datos anómalos no se borran ni se corrigen: se marcan. Marcas por valor:
      esp  fuera de la especificación del sensor        cor  fuera de especificación por la corrección
      sos  sospechoso (fuera del rango plausible)
    y por registro (afectan a todas las variables):
      dup  hora repetida                                  rep  registro repetido sin cambios (registrador detenido)
      pru  periodo de prueba (no entra en comparaciones ni estadísticas)
  - Los agregados usan la agregación de cada variable (media, máximo, media circular, último valor).
  - Los acumulados de lluvia se reinician: el total del día es el último valor del día.

Uso:
  python src/meteorologia.py                                procesa todos los Parquet de Metorologia/
  python src/meteorologia.py --validar ARCHIVO --nombre X   revisa un Parquet subido (sin procesar) e
                                                            imprime un resumen en JSON (lo usa la página)
"""

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from en_vivo import ejecucion, progreso

RAIZ = Path(__file__).resolve().parents[1]
ENTRADA = RAIZ / "Metorologia"
SALIDA = RAIZ / "data" / "processed" / "meteo"

# ───────────────────────── Catálogo ─────────────────────────
ESTACIONES = {  # tabla -> nombre para mostrar (orden de la interfaz)
    "estacionoaqtorre": "OAQ Torre",
    "estacionoaqjardin": "OAQ Jardín",
    "estacioncarapungo": "Carapungo",
    "sangolqui": "Sangolquí",
}
EQUIPO = "Ambient Weather WS-2000"

# variable estándar, columna en la base, nombre, categoría, unidad, tipo, agregación temporal
VARIABLES = [
    ("temperatura", "temperatura", "Temperatura del aire", "Temperatura y humedad", "°C", "instantánea", "media"),
    ("humedad", "humedad", "Humedad relativa", "Temperatura y humedad", "%", "instantánea", "media"),
    ("presion", "presion", "Presión atmosférica (estación)", "Presión", "hPa", "instantánea", "media"),
    ("radiacion_solar", "indiceRadiacion", "Radiación solar global", "Radiación", "W/m²", "instantánea", "media"),
    ("uv", "uv", "Índice UV", "Radiación", "", "instantánea", "maximo"),
    ("velocidad_viento", "velocidadViento", "Velocidad del viento", "Viento", "m/s", "promedio 16 s", "media"),
    ("rafaga_viento", "rafagaViento", "Ráfaga de viento", "Viento", "m/s", "máximo 16 s", "maximo"),
    ("direccion_viento", "direccionViento", "Dirección del viento", "Viento", "°", "instantánea", "circular"),
    ("lluvia_intensidad", "lluviaHora", "Intensidad de precipitación", "Precipitación", "mm/h", "intensidad", "maximo"),
    ("lluvia_evento", "lluviaEvento", "Precipitación del evento", "Precipitación", "mm", "acumulada (evento)", "ultimo"),
    ("lluvia_diaria", "lluviaDiaria", "Precipitación del día", "Precipitación", "mm", "acumulada (día)", "ultimo"),
    ("lluvia_semana", "lluviaSemana", "Precipitación de la semana", "Precipitación", "mm", "acumulada (semana)", "ultimo"),
    ("lluvia_mes", "lluviaMes", "Precipitación del mes", "Precipitación", "mm", "acumulada (mes)", "ultimo"),
    ("lluvia_anio", "lluviaAnio", "Precipitación del año", "Precipitación", "mm", "acumulada (año)", "ultimo"),
]
VARS = [v[0] for v in VARIABLES]
COLUMNA = {v[1]: v[0] for v in VARIABLES}
AGREGACION = {v[0]: v[6] for v in VARIABLES}
DECIMALES = {"temperatura": 2, "humedad": 2, "presion": 2, "radiacion_solar": 2, "uv": 1, "velocidad_viento": 2,
             "rafaga_viento": 2, "direccion_viento": 0, "lluvia_intensidad": 2, "lluvia_evento": 2, "lluvia_diaria": 2,
             "lluvia_semana": 2, "lluvia_mes": 2, "lluvia_anio": 2}

# Especificación del fabricante (solo los límites que constan en el documento del proyecto)
ESPECIFICACION = {"uv": (0, 15), "radiacion_solar": (0, 2367.8), "humedad": (0, 99)}
# Rangos plausibles: PROPUESTA PROVISIONAL, a validar con el OAQ
PLAUSIBLE = {"temperatura": (-10, 40)}
PRESION_MAX_DESVIO = 30  # hPa respecto a la mediana de la estación (propuesta provisional)
# Exactitud del fabricante (para interpretar diferencias entre estaciones)
EXACTITUD = {"temperatura": "±1,1 °C", "humedad": "±5 %", "velocidad_viento": "±1 m/s o 10 %",
             "rafaga_viento": "±1 m/s o 10 %", "lluvia_diaria": "±10 %", "radiacion_solar": "±15 %", "uv": "±1"}

LLUVIA = ["lluvia_intensidad", "lluvia_evento", "lluvia_diaria", "lluvia_semana", "lluvia_mes", "lluvia_anio"]
CORREGIDAS = ["temperatura", "humedad", "presion", "velocidad_viento", "rafaga_viento"]
# Eventos conocidos. Intervalo [inicio, fin); fin None = vigente.
EVENTOS = [
    {"id": 1, "tabla": "estacioncarapungo", "inicio": "2026-08-26 14:55", "fin": "2026-08-29 16:30",
     "tipo": "periodo_prueba", "variables": VARS, "efecto": "excluir_comparaciones",
     "descripcion": "La estación funcionaba antes de su instalación (presión ≈ 728 hPa, igual que el OAQ; "
                    "salta a ≈ 744 hPa al trasladarla). Se muestra marcada y no entra en comparaciones ni estadísticas."},
    {"id": 2, "tabla": "estacionoaqtorre", "inicio": None, "fin": None, "tipo": "correccion_no_documentada",
     "variables": CORREGIDAS, "efecto": "comparar_con_precaucion",
     "descripcion": "El servidor aplica una corrección sin documentación en todo el registro "
                    "(humedad = 1,0034·h + 0,037)."},
    {"id": 3, "tabla": "estacionoaqjardin", "inicio": None, "fin": None, "tipo": "correccion_no_documentada",
     "variables": CORREGIDAS, "efecto": "comparar_con_precaucion",
     "descripcion": "Corrección sin documentación en todo el registro (mismo patrón que OAQ Torre)."},
    {"id": 4, "tabla": "estacioncarapungo", "inicio": "2026-08-29 16:30", "fin": None,
     "tipo": "correccion_no_documentada", "variables": LLUVIA, "efecto": "comparar_con_precaucion",
     "descripcion": "Las seis variables de lluvia llegan con un factor ≈ 1,11 sin documentación, desde la instalación."},
    {"id": 5, "tabla": "sangolqui", "inicio": "2024-11-20 00:00", "fin": "2026-10-30 00:00",
     "tipo": "correccion_no_documentada", "variables": CORREGIDAS, "efecto": "comparar_con_precaucion",
     "descripcion": "Corrección sin documentación en temperatura, humedad, presión, velocidad y ráfaga. "
                    "Antes del 20 nov 2024 los datos llegan sin corrección: hay una discontinuidad."},
    {"id": 6, "tabla": "sangolqui", "inicio": "2026-10-30 00:00", "fin": None,
     "tipo": "correccion_no_documentada", "variables": ["temperatura", "humedad", "rafaga_viento"],
     "efecto": "comparar_con_precaucion",
     "descripcion": "Desde el 30 oct 2026 la corrección sigue en temperatura, humedad y ráfaga; presión y velocidad "
                    "vuelven a llegar sin corrección."},
]
ETIQUETA_MARCA = {"esp": "fuera de especificación", "cor": "fuera de especificación por la corrección",
                  "sos": "sospechoso", "dup": "hora repetida", "rep": "registro repetido sin cambios",
                  "pru": "periodo de prueba"}
MARCAS_REGISTRO = ["dup", "rep", "pru"]
RECIENTE_HORAS = 72


def _t(texto: str | None) -> pd.Timestamp | None:
    return None if texto is None else pd.Timestamp(texto)


def en_evento(tiempo: pd.Series, ev: dict) -> pd.Series:
    dentro = pd.Series(True, index=tiempo.index)
    if ev["inicio"]:
        dentro &= tiempo >= _t(ev["inicio"])
    if ev["fin"]:
        dentro &= tiempo < _t(ev["fin"])
    return dentro


# ───────────────────────── Lectura y marcas ─────────────────────────
def leer(ruta: Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series]:
    """Devuelve (datos, marcas por variable, marca de registro). Los valores no se cambian."""
    tabla = ruta.stem
    crudo = pd.read_parquet(ruta)
    d = crudo.rename(columns=COLUMNA)[["id", "tiempo"] + VARS].sort_values(["tiempo", "id"], kind="stable")
    d = d.reset_index(drop=True)
    d[VARS] = d[VARS].astype(float)

    registro = pd.Series("", index=d.index, dtype=object)
    # Periodo de prueba (evento conocido: tiene prioridad sobre las demás marcas de registro)
    for ev in EVENTOS:
        if ev["tabla"] == tabla and ev["tipo"] == "periodo_prueba":
            registro[en_evento(d["tiempo"], ev)] = "pru"
    # Hora repetida: se conserva la primera
    registro[d["tiempo"].duplicated(keep="first") & registro.eq("")] = "dup"
    # Registrador detenido: 12 registros o más (≥ 1 h) idénticos en las 14 variables. Se conserva el primero.
    iguales = d[VARS].diff().abs().fillna(1).sum(axis=1).eq(0) & d[VARS].notna().any(axis=1)
    tramo = (~iguales).cumsum()
    largo = tramo.map(tramo.value_counts())
    registro[(iguales & (largo >= 12)) & registro.eq("")] = "rep"

    marcas = pd.DataFrame("", index=d.index, columns=VARS, dtype=object)
    corregida = pd.DataFrame(False, index=d.index, columns=VARS)
    for ev in EVENTOS:
        if ev["tabla"] == tabla and ev["tipo"] == "correccion_no_documentada":
            dentro = en_evento(d["tiempo"], ev)
            for v in ev["variables"]:
                corregida.loc[dentro, v] = True
    for v, (lo, hi) in ESPECIFICACION.items():
        fuera = (d[v] < lo) | (d[v] > hi)
        marcas.loc[fuera & corregida[v], v] = "cor"
        marcas.loc[fuera & ~corregida[v], v] = "esp"
    for v, (lo, hi) in PLAUSIBLE.items():
        marcas.loc[((d[v] < lo) | (d[v] > hi)) & marcas[v].eq(""), v] = "sos"
    mediana = d.loc[registro.eq(""), "presion"].median()
    marcas.loc[((d["presion"] - mediana).abs() > PRESION_MAX_DESVIO) & marcas["presion"].eq(""), "presion"] = "sos"
    return d, marcas, registro


def texto_marcas(marcas: pd.DataFrame, registro: pd.Series) -> pd.Series:
    """Marca compacta por registro: '*:rep' o 'humedad:cor uv:esp'."""
    salida = pd.Series("", index=marcas.index, dtype=object)
    hay = marcas.ne("").any(axis=1)
    if hay.any():
        sub = marcas[hay]
        salida[hay] = [" ".join(f"{v}:{m}" for v, m in zip(VARS, fila) if m) for fila in sub.itertuples(index=False)]
    salida[registro.ne("")] = "*:" + registro[registro.ne("")]
    return salida


def valores_limpios(d: pd.DataFrame, marcas: pd.DataFrame, registro: pd.Series, incluir_marcados: bool) -> pd.DataFrame:
    """Valores para agregar: sin marcados (o con ellos), y nunca el periodo de prueba ni las horas repetidas."""
    fuera = registro.isin(["pru", "dup"]) if incluir_marcados else registro.ne("")
    x = d[~fuera].copy()
    if not incluir_marcados:
        m = marcas.loc[x.index]
        for v in VARS:
            x.loc[m[v].ne(""), v] = np.nan
    return x.set_index("tiempo")


# ───────────────────────── Agregación ─────────────────────────
def agregar(x: pd.DataFrame, regla: str) -> pd.DataFrame:
    g = x.resample(regla)
    salida = {}
    for v in VARS:
        a = AGREGACION[v]
        if a == "media":
            salida[v] = g[v].mean()
        elif a == "maximo":
            salida[v] = g[v].max()
        elif a == "ultimo":
            salida[v] = g[v].last()
        elif a == "circular":
            r = np.deg2rad(x[v])
            s, c = np.sin(r).resample(regla).mean(), np.cos(r).resample(regla).mean()
            salida[v] = (np.rad2deg(np.arctan2(s, c)) % 360).where(g[v].count() > 0)
    tabla = pd.DataFrame(salida)
    if regla == "1D":
        tabla.insert(1, "temperatura_min", g["temperatura"].min())
        tabla.insert(2, "temperatura_max", g["temperatura"].max())
    tabla.insert(0, "n", g["id"].count())
    tabla.insert(1, "id_min", g["id"].min())
    tabla.insert(2, "id_max", g["id"].max())
    return tabla[tabla["n"] > 0]


def escribir(tabla: pd.DataFrame, ruta: Path, indice: str, formato: str) -> None:
    t = tabla.rename_axis(indice).reset_index()
    t[indice] = t[indice].dt.strftime(formato)
    dec = {**DECIMALES, "temperatura_min": 2, "temperatura_max": 2}
    t = t.round({k: v for k, v in dec.items() if k in t})
    for c in ("n", "id", "id_min", "id_max"):
        if c in t:
            t[c] = t[c].astype("Int64")
    ruta.parent.mkdir(parents=True, exist_ok=True)
    t.to_csv(ruta, index=False)


# ───────────────────────── Calidad y notas ─────────────────────────
def fecha_corta(t: pd.Timestamp) -> str:
    meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
    return f"{t.day} {meses[t.month - 1]} {t.year}"


def miles(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def resumen_calidad(d: pd.DataFrame, marcas: pd.DataFrame, registro: pd.Series) -> dict:
    validos = d[registro.isin(["", "pru"])]
    salto = validos["tiempo"].diff()
    intervalo = salto.median()
    huecos = salto[salto > pd.Timedelta("1h")]
    duracion = (validos["tiempo"].max() - validos["tiempo"].min()).total_seconds()
    esperados = duracion / intervalo.total_seconds() + 1 if intervalo.total_seconds() else len(validos)
    por_variable = {}
    for v in VARS:
        conteo = marcas[v].value_counts()
        c = {m: int(conteo.get(m, 0)) for m in ("esp", "cor", "sos")}
        nulos = int(d.loc[registro.eq(""), v].isna().sum())
        if nulos:
            c["nulos"] = nulos
        if any(c.values()):
            por_variable[v] = c
    return {
        "registros": int(len(d)),
        "por_marca_registro": {m: int((registro == m).sum()) for m in MARCAS_REGISTRO},
        "intervalo_min": round(intervalo.total_seconds() / 60, 1),
        "huecos": int(len(huecos)),
        "mayor_hueco_h": round(huecos.max().total_seconds() / 3600, 1) if len(huecos) else 0,
        "lista_huecos": [{"desde": (fin - dur).isoformat(), "hasta": fin.isoformat(),
                          "horas": round(dur.total_seconds() / 3600, 1)}
                         for fin, dur in zip(validos.loc[huecos.index, "tiempo"], huecos)],
        "cobertura_pct": round(min(100, 100 * len(validos) / esperados), 1),
        "por_variable": por_variable,
    }


def nota_detenido(d: pd.DataFrame, registro: pd.Series) -> list[str]:
    rep = registro.eq("rep")
    if not rep.any():
        return []
    tramo = (~rep).cumsum()[rep]
    grupos = d.loc[rep, "tiempo"].groupby(tramo).agg(["min", "max", "count"])
    mayor = grupos.loc[grupos["count"].idxmax()]
    texto = (f"El registrador repitió el mismo registro, sin cambios en ninguna de las 14 variables, en {len(grupos)} "
             f"tramo(s) de 1 h o más ({miles(int(rep.sum()))} registros marcados). El más largo va del "
             f"{fecha_corta(mayor['min'])} al {fecha_corta(mayor['max'])}.")
    if registro.iloc[-1] == "rep":
        texto += (" Sigue así en el último registro recibido: la estación transmite, pero sus valores no cambian; "
                  "ni siquiera la precipitación del día se reinicia a medianoche.")
    return [texto]


def nota_amplitud(dia: pd.DataFrame) -> list[str]:
    completos = dia[dia["n"] >= 0.9 * 288]
    if len(completos) < 7:
        return []
    amp = (completos["temperatura_max"] - completos["temperatura_min"]).median()
    if amp >= 4:
        return []
    amp = f"{amp:.1f}".replace(".", ",")
    return [f"La temperatura cambia muy poco entre el día y la noche: amplitud diaria típica de {amp} °C "
            "(en las otras estaciones, de 7 a 12 °C). Conviene revisar la ubicación o la protección del sensor exterior."]


def nota_parecido(datos: dict[str, pd.DataFrame], registros: dict[str, pd.Series]) -> dict[str, list[str]]:
    """Proporción de registros idénticos entre pares de estaciones, alineados por hora (±2 min)."""
    notas = {k: [] for k in datos}
    claves = list(datos)
    comparar = ["temperatura", "humedad", "presion", "radiacion_solar", "velocidad_viento", "direccion_viento",
                "rafaga_viento", "uv"]
    for i, a in enumerate(claves):
        for b in claves[i + 1:]:
            da = datos[a][registros[a].eq("")]
            db = datos[b][registros[b].eq("")]
            m = pd.merge_asof(da, db, on="tiempo", direction="nearest", tolerance=pd.Timedelta("2min"),
                              suffixes=("_a", "_b")).dropna(subset=["id_b"])
            if len(m) < 288:
                continue
            ident = np.all([m[f"{c}_a"].eq(m[f"{c}_b"]) for c in comparar], axis=0).mean()
            temp = m["temperatura_a"].eq(m["temperatura_b"]).mean()
            if ident < 0.2:
                continue
            texto = (f"al alinear los registros por hora (±2 min), el {ident * 100:.0f} % coincide exactamente en las 8 "
                     f"variables medidas y el {temp * 100:.0f} % en temperatura ({miles(len(m))} registros comunes). "
                     "Con la exactitud del fabricante (±1,1 °C) dos sensores distintos rara vez darían el mismo valor; "
                     "conviene confirmar si ambas tablas reciben datos de la misma consola.")
            notas[a].append(f"Comparada con {ESTACIONES.get(b, b)}: {texto}")
            notas[b].append(f"Comparada con {ESTACIONES.get(a, a)}: {texto}")
    return notas


def ultima_lectura(d: pd.DataFrame, marcas: pd.DataFrame, registro: pd.Series) -> dict:
    """Último valor válido de cada variable, con su hora e id (trazabilidad)."""
    ok = registro.eq("")
    salida = {}
    for v in VARS:
        validos = d[ok & marcas[v].eq("") & d[v].notna()]
        if validos.empty:
            continue
        f = validos.iloc[-1]
        salida[v] = {"valor": round(float(f[v]), DECIMALES[v]), "tiempo": f["tiempo"].isoformat(), "id": int(f["id"])}
    return salida


def discontinuidades(tabla: str, desde: pd.Timestamp, hasta: pd.Timestamp) -> list[dict]:
    salida = []
    for ev in EVENTOS:
        if ev["tabla"] != tabla:
            continue
        for borde, que in ((ev["inicio"], "inicio"), (ev["fin"], "fin")):
            t = _t(borde)
            if t is None or not (desde < t <= hasta):
                continue
            if ev["tipo"] == "periodo_prueba":
                if que == "inicio":
                    continue
                texto = "Instalación (fin del periodo de prueba)"
            else:
                texto = ("Empieza" if que == "inicio" else "Termina") + " una corrección no documentada"
            salida.append({"tiempo": t.isoformat(), "variables": ev["variables"], "texto": texto, "evento": ev["id"]})
    return salida


# ───────────────────────── Principal ─────────────────────────
def main() -> None:
    with ejecucion("meteorologia"):
        archivos = {p.stem: p for p in sorted(ENTRADA.glob("*.parquet")) if not p.name.startswith(".")}
        if not archivos:
            raise SystemExit(f"No hay archivos .parquet en {ENTRADA}")
        orden = [t for t in ESTACIONES if t in archivos] + [t for t in archivos if t not in ESTACIONES]
        nuevo = SALIDA.with_name("meteo.nuevo")
        shutil.rmtree(nuevo, ignore_errors=True)
        nuevo.mkdir(parents=True)

        datos, registros, estaciones, recientes = {}, {}, [], []
        for k, tabla in enumerate(orden):
            ruta = archivos[tabla]
            nombre = ESTACIONES.get(tabla, tabla)
            progreso("estaciones", k, len(orden), nombre)
            d, marcas, registro = leer(ruta)
            datos[tabla], registros[tabla] = d, registro

            # 5 min, un archivo por mes, con todas las filas y sus marcas
            todo = d.assign(marcas=texto_marcas(marcas, registro)).set_index("tiempo")
            meses = []
            for mes, parte in todo.groupby(todo.index.to_period("M")):
                escribir(parte, nuevo / "5min" / tabla / f"{mes}.csv", "tiempo", "%Y-%m-%d %H:%M:%S")
                meses.append(str(mes))

            limpio = valores_limpios(d, marcas, registro, incluir_marcados=False)
            con_marcados = valores_limpios(d, marcas, registro, incluir_marcados=True)
            for carpeta, regla, formato in (("hora", "1h", "%Y-%m-%d %H:%M"), ("dia", "1D", "%Y-%m-%d")):
                escribir(agregar(limpio, regla), nuevo / carpeta / f"{tabla}.csv", carpeta, formato)
                escribir(agregar(con_marcados, regla), nuevo / carpeta / f"{tabla}_todos.csv", carpeta, formato)
            dia = agregar(limpio, "1D")

            ok = registro.eq("")
            ultima_med = d.loc[ok, "tiempo"].max()
            lluvia_dia = d.loc[ok & (d["tiempo"].dt.normalize() == ultima_med.normalize()), "lluvia_diaria"].dropna()
            mtime = datetime.fromtimestamp(ruta.stat().st_mtime, tz=timezone.utc)
            estaciones.append({
                "tabla": tabla,
                "nombre": nombre,
                "equipo": EQUIPO,
                "archivo": f"Metorologia/{ruta.name}",
                "archivo_modificado": mtime.isoformat(),
                "primer_registro": d["tiempo"].min().isoformat(),
                "ultimo_registro": d["tiempo"].max().isoformat(),
                "ultima_medicion": ultima_med.isoformat(),
                "lluvia_dia_ultima_medicion": None if lluvia_dia.empty else round(float(lluvia_dia.iloc[-1]), 2),
                "ultima": ultima_lectura(d, marcas, registro),
                "variables": VARS,  # las cuatro estaciones activas tienen las 14 variables
                "meses": meses,
                "calidad": resumen_calidad(d, marcas, registro),
                "discontinuidades": discontinuidades(tabla, d["tiempo"].min(), d["tiempo"].max()),
                "notas": nota_detenido(d, registro) + nota_amplitud(dia),
            })
            recientes.append(limpio.assign(tabla=tabla))
            marcados = registro[registro.ne("")].value_counts()
            print(f"{nombre}: {len(d):,} registros, {d['tiempo'].min():%Y-%m-%d} -> {d['tiempo'].max():%Y-%m-%d}; "
                  f"registros marcados: " + (", ".join(f"{m} {n}" for m, n in marcados.items()) or "ninguno"))

        for e, extra in zip(estaciones, nota_parecido(datos, registros).values()):
            e["notas"] += extra

        # Últimas 72 h de la red (hasta la medición válida más reciente)
        fin = max(pd.Timestamp(e["ultima_medicion"]) for e in estaciones)
        rec = pd.concat(recientes)
        rec = rec[rec.index > fin - pd.Timedelta(hours=RECIENTE_HORAS)]
        cols = ["tabla", "id", "temperatura", "humedad", "presion", "radiacion_solar", "uv", "velocidad_viento",
                "rafaga_viento", "lluvia_intensidad", "lluvia_diaria"]
        escribir(rec[cols], nuevo / "reciente.csv", "tiempo", "%Y-%m-%d %H:%M:%S")

        meta = {
            "generado": datetime.now(timezone.utc).isoformat(),
            "zona_horaria": "Hora local de Ecuador (UTC−5, sin horario de verano), hora de registro en el servidor",
            "variables": [{"variable": v, "columna": c, "nombre": n, "categoria": cat, "unidad": u, "tipo": t,
                           "agregacion": a, "exactitud": EXACTITUD.get(v)} for v, c, n, cat, u, t, a in VARIABLES],
            "especificacion": ESPECIFICACION,
            "plausible": {**{k: list(v) for k, v in PLAUSIBLE.items()},
                          "presion": f"±{PRESION_MAX_DESVIO} hPa de la mediana de la estación"},
            "marcas": ETIQUETA_MARCA,
            "eventos": EVENTOS,
            "reciente_horas": RECIENTE_HORAS,
            "estaciones": estaciones,
        }
        (nuevo / "estaciones.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))

        # Se reemplaza la carpeta completa: el navegador ve la versión anterior o la nueva, no una mezcla
        viejo = SALIDA.with_name("meteo.viejo")
        shutil.rmtree(viejo, ignore_errors=True)
        if SALIDA.exists():
            SALIDA.rename(viejo)
        nuevo.rename(SALIDA)
        shutil.rmtree(viejo, ignore_errors=True)
        progreso("estaciones", len(orden), len(orden), "listo")
        print(f"Listo: {SALIDA.relative_to(RAIZ)}/")


# ───────────────────────── Validación de un archivo subido ─────────────────────────
COLUMNAS_REQUERIDAS = ["id", "tiempo"] + [v[1] for v in VARIABLES]


def _resumen(d: pd.DataFrame) -> dict:
    return {"registros": int(len(d)), "desde": d["tiempo"].min().isoformat(), "hasta": d["tiempo"].max().isoformat()}


def validar(ruta: Path, nombre: str) -> dict:
    """Revisa que un Parquet tenga el esquema de las estaciones y lo compara con el archivo actual."""
    import pyarrow.parquet as pq

    errores, avisos = [], []
    tabla = Path(nombre).stem
    salida = {"ok": False, "archivo": nombre, "tabla": tabla, "estacion": ESTACIONES.get(tabla, tabla),
              "errores": errores, "avisos": avisos}
    try:
        esquema = pq.read_schema(ruta)
    except Exception as e:  # noqa: BLE001 - cualquier fallo de lectura se informa al usuario
        errores.append(f"No es un archivo Parquet legible ({type(e).__name__}).")
        return salida
    columnas = esquema.names
    faltan = [c for c in COLUMNAS_REQUERIDAS if c not in columnas]
    if faltan:
        errores.append("Faltan columnas: " + ", ".join(faltan) + ".")
        return salida
    sobran = [c for c in columnas if c not in COLUMNAS_REQUERIDAS]
    if sobran:
        avisos.append("Columnas que la página no usa (se ignoran): " + ", ".join(sobran) + ".")
    d = pd.read_parquet(ruta, columns=COLUMNAS_REQUERIDAS)
    if not pd.api.types.is_datetime64_any_dtype(d["tiempo"]):
        errores.append(f"La columna tiempo debe ser fecha y hora (es {d['tiempo'].dtype}).")
        return salida
    if getattr(d["tiempo"].dt, "tz", None) is not None:
        errores.append("La columna tiempo trae zona horaria; se espera hora local de Ecuador sin zona.")
        return salida
    if d.empty:
        errores.append("El archivo no tiene registros.")
        return salida
    no_numericas = [c for c in COLUMNAS_REQUERIDAS[2:] if not pd.api.types.is_numeric_dtype(d[c])]
    if no_numericas:
        errores.append("Columnas que deberían ser numéricas: " + ", ".join(no_numericas) + ".")
        return salida
    salida["nuevo"] = _resumen(d)
    if tabla not in ESTACIONES:
        avisos.append(f"«{tabla}» no es una de las estaciones conocidas: aparecerá como estación nueva, con ese nombre.")
    actual = ENTRADA / nombre
    if actual.exists():
        a = pd.read_parquet(actual, columns=["id", "tiempo"])
        salida["actual"] = _resumen(a)
        salida["registros_nuevos"] = int((d["tiempo"] > a["tiempo"].max()).sum())
        if len(d) < len(a):
            avisos.append(f"Tiene menos registros que el archivo actual ({len(d):,} frente a {len(a):,}).".replace(",", " "))
        if d["tiempo"].min() > a["tiempo"].min():
            avisos.append("Empieza después que el archivo actual: al reemplazarlo se perdería el historial anterior "
                          f"al {d['tiempo'].min():%Y-%m-%d %H:%M}.")
        if d["tiempo"].max() < a["tiempo"].max():
            avisos.append("Termina antes que el archivo actual: no trae datos más recientes.")
        elif salida["registros_nuevos"] == 0:
            avisos.append("No trae registros posteriores a los del archivo actual.")
    else:
        salida["registros_nuevos"] = int(len(d))
    salida["ok"] = True
    return salida


if __name__ == "__main__":
    argumentos = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    argumentos.add_argument("--validar", type=Path, help="Parquet a revisar (no se procesa ni se copia)")
    argumentos.add_argument("--nombre", help="nombre final del archivo, p. ej. sangolqui.parquet")
    a = argumentos.parse_args()
    if a.validar:
        print(json.dumps(validar(a.validar, a.nombre or a.validar.name), ensure_ascii=False))
    else:
        main()
