"""Figuras exploratorias iniciales (fase 2 del proyecto).

  fig1_ciclos.png            manchas y fulguraciones mensuales 1995-hoy (ciclos 23, 24, 25)
  fig2_mariposa_observada.png  latitud de las fulguraciones vs tiempo (ley de Spörer)
  fig3_goes_diario.png       XRS, EUV 30.4 nm y Mg II diarios de GOES-R desde 2017
  fig4_ley_potencia.png      distribución del flujo pico y exponente de la ley de potencia

Uso:
  python src/explorar.py
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from en_vivo import ejecucion, progreso

RAIZ = Path(__file__).resolve().parents[1]
PROC = RAIZ / "data" / "processed"
FIG = RAIZ / "figuras"

AZUL, NARANJA, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
TEXTO, TEXTO_2, REJILLA = "#0b0b0b", "#52514e", "#e4e3df"

plt.rcParams.update({
    "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb",
    "axes.edgecolor": REJILLA, "axes.labelcolor": TEXTO_2, "axes.titlecolor": TEXTO,
    "axes.titlesize": 11, "axes.titleweight": "bold", "axes.titlelocation": "left",
    "axes.grid": True, "grid.color": REJILLA, "grid.linewidth": 0.6,
    "axes.spines.top": False, "axes.spines.right": False,
    "xtick.color": TEXTO_2, "ytick.color": TEXTO_2, "font.size": 9,
    "lines.linewidth": 1.4, "legend.frameon": False,
})


def fig_ciclos() -> None:
    m = pd.read_csv(PROC / "indices_mensuales.csv", parse_dates=["mes_inicio"]).set_index("mes_inicio")
    fig, ax = plt.subplots(3, 1, figsize=(10, 7.5), sharex=True)
    ax[0].plot(m.index, m["manchas"], color=AZUL, alpha=0.35, linewidth=1, label="Mensual")
    ax[0].plot(m.index, m["manchas_13m"], color=AZUL, linewidth=2, label="Media móvil 13 meses")
    ax[0].set_title("Número de manchas solares (SILSO)")
    ax[0].legend(loc="lower right", bbox_to_anchor=(1, 1), ncols=2)
    ax[1].bar(m.index, m["n_M"] + m["n_X"], width=25, color=NARANJA)
    ax[1].set_title("Fulguraciones M y X por mes (GOES)")
    ax[2].bar(m.index, m["n_C"], width=25, color=NARANJA)
    ax[2].set_title("Fulguraciones C por mes (GOES)")
    # Mínimos que marcan el inicio de cada ciclo (SILSO)
    for inicio, ciclo in [("1996-08", "Ciclo 23"), ("2008-12", "Ciclo 24"), ("2019-12", "Ciclo 25")]:
        for a in ax:
            a.axvline(pd.Timestamp(inicio), color=TEXTO_2, linestyle=":", linewidth=1)
        ax[0].text(pd.Timestamp(inicio) + pd.DateOffset(months=4), ax[0].get_ylim()[1] * 0.88, ciclo, color=TEXTO_2)
    fig.tight_layout()
    fig.savefig(FIG / "fig1_ciclos.png", dpi=150)
    plt.close(fig)


def fig_mariposa() -> None:
    f = pd.read_csv(PROC / "fulguraciones.csv", parse_dates=["pico"])
    f = f[f["lat"].notna() & f["letra"].isin(["C", "M", "X"])]
    fig, ax = plt.subplots(figsize=(10, 4.5))
    c = f[f["letra"] == "C"]
    mx = f[f["letra"].isin(["M", "X"])]
    ax.scatter(c["pico"], c["lat"], s=2, color=AZUL, alpha=0.25, linewidths=0, label=f"Clase C ({len(c):,})")
    ax.scatter(mx["pico"], mx["lat"], s=9, color=NARANJA, alpha=0.8, linewidths=0, label=f"Clases M y X ({len(mx):,})")
    ax.set_ylim(-60, 60)
    ax.set_ylabel("Latitud heliográfica (°)")
    ax.set_title("Diagrama mariposa observado: latitud de las fulguraciones")
    ax.legend(loc="upper left", markerscale=3, ncols=2)
    fig.tight_layout()
    fig.savefig(FIG / "fig2_mariposa_observada.png", dpi=150)
    plt.close(fig)


def fig_goes_diario() -> None:
    g = pd.read_csv(PROC / "goes_diario_compuesto.csv", parse_dates=["fecha"]).set_index("fecha")
    g = g[g["irr_304"].first_valid_index():]  # la figura compara con EUV, que existe solo desde GOES-16
    s = pd.read_csv(PROC / "manchas_diarias.csv", parse_dates=["fecha"]).set_index("fecha")["manchas"]
    s = s[s.index >= g.index.min()]
    series = [
        (g["bkd1d_xrsb_flux"], "Fondo diario de rayos X, XRS-B 0.1–0.8 nm (W/m²)", True),
        (g["irr_304"] * 1e3, "EUV He II 30.4 nm (mW/m²)", False),
        (g["MgII_standard"], "Índice Mg II (núcleo/ala)", False),
        (s, "Número de manchas diario (SILSO; último mes: estimación EISN)", False),
    ]
    fig, ax = plt.subplots(len(series), 1, figsize=(10, 9), sharex=True)
    for a, (serie, titulo, log) in zip(ax, series):
        a.plot(serie.index, serie, color=AZUL, alpha=0.35, linewidth=0.7)
        a.plot(serie.index, serie.rolling(27, center=True, min_periods=14).mean(), color=AZUL, linewidth=1.8)
        a.set_title(titulo + "  ·  línea gruesa: media de 27 días (una rotación)")
        if log:
            a.set_yscale("log")
    fig.tight_layout()
    fig.savefig(FIG / "fig3_goes_diario.png", dpi=150)
    plt.close(fig)


def fig_ley_potencia() -> float:
    f = pd.read_csv(PROC / "fulguraciones.csv")
    x = f.loc[f["peak_saturated"] == 0, "flujo_pico"].to_numpy()
    xmin = 2e-6  # por debajo de ~C2 el catálogo está incompleto (el fondo tapa eventos pequeños)
    cola = x[x >= xmin]
    # Estimador de máxima verosimilitud (Clauset, Shalizi y Newman 2009)
    alfa = 1 + len(cola) / np.sum(np.log(cola / xmin))
    err = (alfa - 1) / np.sqrt(len(cola))

    bordes = np.logspace(-7, -3, 41)
    hist, _ = np.histogram(x, bordes)
    centros = np.sqrt(bordes[1:] * bordes[:-1])
    densidad = hist / np.diff(bordes)
    fig, ax = plt.subplots(figsize=(7, 4.5))
    ax.loglog(centros[hist > 0], densidad[hist > 0], "o", color=AZUL, markersize=5, label="Catálogo GOES 1995–2026")
    ref = centros[centros >= xmin]
    # Densidad esperada: N_cola · (α-1)/xmin · (x/xmin)^-α
    modelo = len(cola) * (alfa - 1) / xmin * (ref / xmin) ** -alfa
    ax.loglog(ref, modelo, color=NARANJA, linewidth=2, label=f"Ley de potencia, α = {alfa:.2f} ± {err:.2f}")
    ax.axvline(xmin, color=TEXTO_2, linestyle=":", linewidth=1)
    ax.text(xmin * 1.15, densidad.max() * 0.5, "umbral de\ncompletitud", color=TEXTO_2, fontsize=8)
    ax.set_xlabel("Flujo pico XRS-B (W/m²)   ·   C = 10⁻⁶, M = 10⁻⁵, X = 10⁻⁴")
    ax.set_ylabel("Eventos por unidad de flujo")
    ax.set_title("Distribución de tamaños de las fulguraciones")
    ax.legend(loc="lower left")
    fig.tight_layout()
    fig.savefig(FIG / "fig4_ley_potencia.png", dpi=150)
    plt.close(fig)
    return alfa


def main() -> None:
    FIG.mkdir(exist_ok=True)
    with ejecucion("explorar"):
        pasos = [("fig1_ciclos.png", fig_ciclos), ("fig2_mariposa_observada.png", fig_mariposa),
                 ("fig3_goes_diario.png", fig_goes_diario), ("fig4_ley_potencia.png", fig_ley_potencia)]
        for i, (nombre, funcion) in enumerate(pasos):
            progreso("figuras", i, len(pasos), nombre)
            resultado = funcion()
            print(f"  {nombre}")
        progreso("figuras", len(pasos), len(pasos), "listo")
        print(f"Figuras en {FIG.relative_to(RAIZ)}/  ·  exponente ley de potencia α = {resultado:.3f}")


if __name__ == "__main__":
    main()
