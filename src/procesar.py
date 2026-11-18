"""Convierte los datos crudos en tablas limpias (CSV) listas para análisis.

Salidas en data/processed/:
  fulguraciones.csv      una fila por fulguración (1995-hoy), con clase, flujo pico,
                         duración, tiempo de subida, latitud/longitud heliográfica
  goes_diario.csv        flujo XRS e irradiancia EUV diarios por satélite (formato largo).
                         XRS desde 1995 (GOES-8 a 19); EUV solo desde 2017 (GOES-16 a 19)
  goes_diario_compuesto.csv  mediana entre satélites por día (una fila por día)
  manchas_diarias.csv, manchas_mensuales.csv   número de manchas SILSO
  indices_mensuales.csv  conteo mensual de fulguraciones C/M/X + manchas + XRS medio

Uso:
  python src/procesar.py
"""

from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

from en_vivo import ejecucion, progreso

RAIZ = Path(__file__).resolve().parents[1]
RAW = RAIZ / "data" / "raw"
PROC = RAIZ / "data" / "processed"

# Umbral inferior (W/m²) de cada clase de fulguración en la banda XRS-B (0.1-0.8 nm)
BASE_CLASE = {"A": 1e-8, "B": 1e-7, "C": 1e-6, "M": 1e-5, "X": 1e-4}

VARS_XRS = ["avg1d_xrsa_flux", "avg1d_xrsb_flux", "bkd1d_xrsa_flux", "bkd1d_xrsb_flux"]
VARS_EUV = ["irr_256", "irr_284", "irr_304", "irr_1175", "irr_1216", "irr_1335", "irr_1405", "MgII_standard"]


def fulguraciones() -> pd.DataFrame:
    df = pd.read_csv(RAW / "goes" / "catalogo_fulguraciones.csv", low_memory=False,
                     parse_dates=["time", "start_time", "end_time"])
    df = df.rename(columns={"time": "pico", "start_time": "inicio", "end_time": "fin",
                            "xrsb_irrad": "flujo_pico", "flare_class": "clase",
                            "background_irrad": "flujo_fondo",
                            "integrated_irrad_end": "fluencia",
                            "xrsb_irrad_source": "satelite",
                            "active_region": "region_activa"})
    df["letra"] = df["clase"].str[0]
    df = df[df["letra"].isin(BASE_CLASE.keys())].copy()
    # Magnitud continua: log10 del flujo pico (C1 = -6, M1 = -5, X1 = -4)
    df["log_flujo"] = np.log10(df["flujo_pico"])
    df["duracion_min"] = (df["fin"] - df["inicio"]).dt.total_seconds() / 60
    df["subida_min"] = (df["pico"] - df["inicio"]).dt.total_seconds() / 60
    # Posición: se prefiere la de SWPC (observatorios en tierra) y si no, la estimada por XRS
    df["lat"] = df["flare_loc_swpc_hgs_lat"].fillna(df["flare_loc_xrs_hgs_lat"])
    df["lon"] = df["flare_loc_swpc_hgs_lon"].fillna(df["flare_loc_xrs_hgs_lon"])
    cols = ["flare_id", "inicio", "pico", "fin", "clase", "letra", "flujo_pico", "log_flujo",
            "flujo_fondo", "fluencia", "duracion_min", "subida_min", "lat", "lon",
            "region_activa", "satelite", "peak_saturated"]
    df = df[cols].sort_values("pico").reset_index(drop=True)
    df.to_csv(PROC / "fulguraciones.csv", index=False)
    print(f"fulguraciones.csv: {len(df):,} eventos, {df['pico'].min():%Y-%m-%d} -> {df['pico'].max():%Y-%m-%d}")
    return df


def _leer_diario(ruta: Path, variables: list[str]) -> pd.DataFrame:
    ds = xr.open_dataset(ruta)
    salida = {}
    for v in variables:
        if v not in ds:
            continue
        valores = ds[v].where(np.isfinite(ds[v]))
        # Solo datos con bandera 0 (good_data) cuando el producto la trae
        if v.endswith("_flux"):
            bandera = v.replace("_flux", "_flag")
        elif v.startswith("MgII"):
            bandera = "MgII_flag"
        else:
            bandera = f"{v}_flag"
        if bandera in ds:
            valores = valores.where(ds[bandera] == 0)
        salida[v] = valores.values
    return pd.DataFrame(salida, index=pd.to_datetime(ds["time"].values).normalize())


def goes_diario() -> pd.DataFrame:
    partes = []
    # Todos los satélites descargados (python src/descargar.py diarios --sat ...)
    for xrs in sorted((RAW / "goes" / "diarios").glob("xrs_diario_g*.nc")):
        sat = int(xrs.stem.rsplit("_g", 1)[1])
        euv = xrs.with_name(f"euvs_diario_g{sat:02d}.nc")
        d = _leer_diario(xrs, VARS_XRS)
        if euv.exists():
            d = d.join(_leer_diario(euv, VARS_EUV), how="outer")
        d["satelite"] = sat
        partes.append(d.rename_axis("fecha").reset_index())
    largo = pd.concat(partes, ignore_index=True).sort_values(["fecha", "satelite"])
    largo.to_csv(PROC / "goes_diario.csv", index=False)
    # Mediana entre satélites disponibles: reduce saltos cuando cambia el satélite operativo
    compuesto = largo.drop(columns="satelite").groupby("fecha").median()
    validos = largo.dropna(subset=["avg1d_xrsb_flux"])
    compuesto["n_satelites"] = validos.groupby("fecha")["satelite"].nunique().reindex(compuesto.index, fill_value=0)
    compuesto.to_csv(PROC / "goes_diario_compuesto.csv")
    print(f"goes_diario_compuesto.csv: {len(compuesto):,} días, "
          f"{compuesto.index.min():%Y-%m-%d} -> {compuesto.index.max():%Y-%m-%d}")
    return compuesto


def manchas() -> tuple[pd.DataFrame, pd.DataFrame]:
    diarias = pd.read_csv(RAW / "silso" / "manchas_diarias.csv", sep=";", header=None,
                          names=["anio", "mes", "dia", "anio_decimal", "manchas", "desv", "n_obs", "definitivo"])
    diarias["fecha"] = pd.to_datetime(dict(year=diarias.anio, month=diarias.mes, day=diarias.dia))
    diarias["manchas"] = diarias["manchas"].where(diarias["manchas"] >= 0)
    diarias["fuente"] = "SILSO"
    cols = ["fecha", "anio_decimal", "manchas", "desv", "n_obs", "definitivo", "fuente"]
    diarias = diarias[cols]

    # Días posteriores al último valor oficial: estimación diaria EISN (provisional)
    ruta_eisn = RAW / "silso" / "eisn_acumulado.csv"
    if ruta_eisn.exists():
        eisn = pd.read_csv(ruta_eisn, header=None,
                           names=["anio", "mes", "dia", "anio_decimal", "manchas", "desv", "n_obs", "n_disponibles"])
        eisn["fecha"] = pd.to_datetime(dict(year=eisn.anio, month=eisn.mes, day=eisn.dia))
        ultimo_oficial = diarias.loc[diarias["manchas"].notna(), "fecha"].max()
        eisn = eisn[eisn["fecha"] > ultimo_oficial].assign(definitivo=0, fuente="EISN")
        diarias = pd.concat([diarias, eisn[cols]], ignore_index=True)
        if len(eisn):
            print(f"manchas_diarias.csv: SILSO hasta {ultimo_oficial:%Y-%m-%d}, "
                  f"EISN del {eisn['fecha'].min():%Y-%m-%d} al {eisn['fecha'].max():%Y-%m-%d}")
    diarias.to_csv(PROC / "manchas_diarias.csv", index=False)

    mensuales = pd.read_csv(RAW / "silso" / "manchas_mensuales.csv", sep=";", header=None,
                            names=["anio", "mes", "anio_decimal", "manchas", "desv", "n_obs", "definitivo"])
    mensuales["mes_inicio"] = pd.to_datetime(dict(year=mensuales.anio, month=mensuales.mes, day=1))
    mensuales["manchas"] = mensuales["manchas"].where(mensuales["manchas"] >= 0)
    # Media móvil centrada de 13 meses, el suavizado estándar para definir ciclos
    mensuales["manchas_13m"] = mensuales["manchas"].rolling(13, center=True).mean()
    mensuales = mensuales[["mes_inicio", "anio_decimal", "manchas", "manchas_13m", "desv", "definitivo"]]
    mensuales.to_csv(PROC / "manchas_mensuales.csv", index=False)
    print(f"manchas_mensuales.csv: {len(mensuales):,} meses desde {mensuales['mes_inicio'].min():%Y}")
    return diarias, mensuales


def indices_mensuales(fl: pd.DataFrame, gd: pd.DataFrame, mm: pd.DataFrame) -> None:
    fl = fl.assign(mes_inicio=fl["pico"].dt.to_period("M").dt.to_timestamp())
    conteo = (fl[fl["letra"].isin(["C", "M", "X"])]
              .pivot_table(index="mes_inicio", columns="letra", values="flare_id", aggfunc="count")
              .reindex(columns=["C", "M", "X"]).fillna(0).astype(int)
              .add_prefix("n_"))
    xrs = gd[["avg1d_xrsb_flux", "bkd1d_xrsb_flux", "irr_304", "MgII_standard"]].resample("MS").mean()
    tabla = (mm.set_index("mes_inicio")[["manchas", "manchas_13m"]]
             .join(conteo, how="left").join(xrs, how="left"))
    # Solo desde que existe el catálogo; meses sin fulguraciones cuentan como 0
    tabla = tabla[tabla.index >= "1995-01-01"]
    tabla[conteo.columns] = tabla[conteo.columns].fillna(0).astype(int)
    tabla.to_csv(PROC / "indices_mensuales.csv")
    print(f"indices_mensuales.csv: {len(tabla):,} meses")


def main() -> None:
    PROC.mkdir(parents=True, exist_ok=True)
    with ejecucion("procesar"):
        progreso("tablas", 0, 4, "fulguraciones")
        fl = fulguraciones()
        progreso("tablas", 1, 4, "GOES diario")
        gd = goes_diario()
        progreso("tablas", 2, 4, "manchas")
        _, mm = manchas()
        progreso("tablas", 3, 4, "índices mensuales")
        indices_mensuales(fl, gd, mm)
        progreso("tablas", 4, 4, "listo")


if __name__ == "__main__":
    main()
