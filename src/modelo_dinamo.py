"""Modelo de dínamo αΩ de campo medio en 1D (onda de dínamo de Parker).

Es la reducción más simple de la ecuación de inducción de la MHD,
    ∂B/∂t = ∇×(v×B) + η∇²B,
promediada sobre la turbulencia convectiva (teoría de campo medio). El campo se
separa en una parte toroidal B(θ,t) y una poloidal representada por el potencial
vector A(θ,t). La dependencia radial se sustituye por un término de decaimiento,
así que solo queda la colatitud θ:

    ∂A/∂t = α(θ) B / (1 + B²) + ∂²A/∂θ² − A        efecto α (convección helicoidal)
    ∂B/∂t = D sinθ ∂A/∂θ     + ∂²B/∂θ² − B        efecto Ω (rotación diferencial)

  - Unidades adimensionales: tiempo en unidades del tiempo de difusión R²/η.
  - D = C_α·C_Ω es el número de dínamo. Si |D| supera un valor crítico aparece
    una onda que oscila. Su signo fija la dirección de migración (regla de
    Parker-Yoshimura): con D < 0 las bandas migran hacia el ecuador, como en el
    Sol; con D > 0 migran hacia los polos. Vale la pena probar ambos.
  - α(θ) = cosθ sin²θ es antisimétrica respecto al ecuador (positiva en el norte).
  - B/(1+B²) es el "α-quenching": el campo intenso frena al efecto α y fija la amplitud.
  - Se impone paridad dipolar (B antisimétrico entre hemisferios), como indica la
    ley de polaridad de Hale.

El periodo se reescala para que un ciclo magnético completo dure 22 años
(11 años por ciclo de manchas), lo que permite comparar el diagrama mariposa
simulado con el observado (figuras/fig2_mariposa_observada.png).

Uso:
  python src/modelo_dinamo.py                 # D = -2000
  python src/modelo_dinamo.py --D -1000 --ciclos 8
  python src/modelo_dinamo.py --D 2000        # migración hacia los polos
  python src/modelo_dinamo.py --pausa 0.02    # más lento, para verlo crecer en la página

Con la página en vivo abierta (web/, `npm run dev`) el diagrama mariposa se dibuja
cuadro a cuadro mientras se integra. En ese caso se hace una pausa corta entre
cuadros (--pausa, 0.004 s por defecto) para que la evolución se alcance a ver;
sin la página, la pausa no se aplica.
"""

import argparse
import time
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import LinearSegmentedColormap

from en_vivo import conectado, ejecucion, emitir

RAIZ = Path(__file__).resolve().parents[1]
FIG = RAIZ / "figuras"
PROC = RAIZ / "data" / "processed"

AZUL, NARANJA = "#2a78d6", "#eb6834"
TEXTO, TEXTO_2, REJILLA = "#0b0b0b", "#52514e", "#e4e3df"
DIVERGENTE = LinearSegmentedColormap.from_list("azul_rojo", ["#104281", "#3987e5", "#f0efec", "#e66767", "#a8201f"])

AÑOS_CICLO_MAGNETICO = 22.0


def simular(D: float, n: int = 121, t_max: float = 8.0, n_guardar: int = 2000, semilla: int = 0,
            al_guardar=None):
    """Integra el sistema con diferencias finitas explícitas. Devuelve θ, t, A(t,θ), B(t,θ).

    `al_guardar(t, B)` se llama con cada cuadro guardado (lo usa la página en vivo)."""
    th = np.linspace(0, np.pi, n)
    h = th[1] - th[0]
    dt = 0.2 * h * h  # estabilidad del esquema explícito de difusión: dt < h²/2
    alfa = np.cos(th) * np.sin(th) ** 2
    s = np.sin(th)

    rng = np.random.default_rng(semilla)
    A = 1e-3 * s * (1 + 0.1 * rng.standard_normal(n))
    B = np.zeros(n)

    pasos = int(t_max / dt)
    cada = max(1, pasos // n_guardar)
    ts, As, Bs = [], [], []
    lapA, lapB, dA = np.zeros(n), np.zeros(n), np.zeros(n)
    for k in range(pasos):
        lapA[1:-1] = (A[2:] - 2 * A[1:-1] + A[:-2]) / h**2
        lapB[1:-1] = (B[2:] - 2 * B[1:-1] + B[:-2]) / h**2
        dA[1:-1] = (A[2:] - A[:-2]) / (2 * h)
        A, B = (A + dt * (alfa * B / (1 + B * B) + lapA - A),
                B + dt * (D * s * dA + lapB - B))
        # Paridad dipolar: A simétrico y B antisimétrico respecto al ecuador
        A = 0.5 * (A + A[::-1])
        B = 0.5 * (B - B[::-1])
        A[[0, -1]] = 0.0  # campo nulo en los polos
        B[[0, -1]] = 0.0
        if k % cada == 0:
            ts.append(k * dt)
            As.append(A.copy())
            Bs.append(B.copy())
            if al_guardar is not None:
                al_guardar(k * dt, B)
    return th, np.array(ts), np.array(As), np.array(Bs)


def periodo(t: np.ndarray, serie: np.ndarray) -> float:
    """Periodo a partir de los cruces por cero (dos cruces = un periodo)."""
    cruces = t[np.where(np.diff(np.sign(serie)) != 0)[0]]
    return 2 * np.mean(np.diff(cruces)) if len(cruces) > 3 else np.nan


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--D", type=float, default=-2000, help="número de dínamo (defecto -2000)")
    p.add_argument("--ciclos", type=int, default=6, help="ciclos magnéticos a mostrar")
    p.add_argument("--pausa", type=float, default=0.004,
                   help="segundos entre cuadros enviados a la página en vivo (defecto 0.004)")
    a = p.parse_args()
    with ejecucion("modelo_dinamo", {"D": a.D, "ciclos": a.ciclos, "pausa": a.pausa}):
        correr(a)


def correr(a: argparse.Namespace) -> None:
    n, t_max, n_guardar = 121, 8.0, 1500
    th_vivo = np.linspace(0, np.pi, n)
    # Mismo cálculo de pasos que simular(), para anunciar cuántos cuadros llegarán
    pasos = int(t_max / (0.2 * (th_vivo[1] - th_vivo[0]) ** 2))
    cuadros = -(-pasos // max(1, pasos // n_guardar))
    emitir("dinamo_config", D=a.D, n=n, t_max=t_max, cuadros=cuadros,
           lat=np.round(90 - np.degrees(th_vivo), 3).tolist())

    def al_guardar(t_actual: float, B_actual: np.ndarray) -> None:
        if not conectado():
            return
        emitir("dinamo_cuadro", tiempo=round(t_actual, 5), B=np.round(B_actual, 4).tolist())
        if a.pausa > 0:
            time.sleep(a.pausa)

    th, t, A, B = simular(a.D, n=n, t_max=t_max, n_guardar=n_guardar, al_guardar=al_guardar)
    lat = 90 - np.degrees(th)
    j30 = np.argmin(abs(lat - 30))
    # Se descarta el transitorio inicial: se analiza solo la segunda mitad
    mitad = len(t) // 2
    P = periodo(t[mitad:], B[mitad:, j30])
    if not np.isfinite(P):
        raise SystemExit(f"D = {a.D}: no hay oscilación (el dínamo decae o es estacionario). Pruebe un |D| mayor.")

    escala = AÑOS_CICLO_MAGNETICO / P
    años = (t - t[-1]) * escala
    ventana = años >= -a.ciclos * AÑOS_CICLO_MAGNETICO
    años, Bv = años[ventana] - años[ventana][0], B[ventana]

    # Migración: latitud del máximo de |B| en el hemisferio norte a lo largo del tiempo
    norte = lat > 0
    lat_max = lat[norte][np.argmax(np.abs(Bv[:, norte]), axis=1)]
    # Proxy de manchas: energía magnética toroidal en latitudes bajas (|lat| < 40°)
    bajas = np.abs(lat) < 40
    actividad = (Bv[:, bajas] ** 2).mean(axis=1)

    FIG.mkdir(exist_ok=True)
    PROC.mkdir(parents=True, exist_ok=True)
    pd.DataFrame({"anio": años, "lat_max_norte": lat_max, "actividad": actividad}).to_csv(
        PROC / "dinamo_serie.csv", index=False)

    plt.rcParams.update({
        "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb", "font.size": 9,
        "axes.edgecolor": REJILLA, "axes.labelcolor": TEXTO_2, "axes.titlecolor": TEXTO,
        "axes.titlesize": 11, "axes.titleweight": "bold", "axes.titlelocation": "left",
        "xtick.color": TEXTO_2, "ytick.color": TEXTO_2,
        "axes.spines.top": False, "axes.spines.right": False,
    })
    fig, ax = plt.subplots(2, 1, figsize=(10, 7), sharex=True, layout="constrained", gridspec_kw={"height_ratios": [2.2, 1]})
    lim = np.abs(Bv).max()
    malla = ax[0].pcolormesh(años, lat, Bv.T, cmap=DIVERGENTE, vmin=-lim, vmax=lim, shading="auto")
    ax[0].plot(años, lat_max, ".", color=TEXTO, markersize=1.2, alpha=0.5)
    ax[0].set_ylabel("Latitud (°)")
    ax[0].set_ylim(-90, 90)
    ax[0].set_yticks([-90, -60, -30, 0, 30, 60, 90])
    ax[0].set_title(f"Diagrama mariposa simulado: campo toroidal B (dínamo αΩ, D = {a.D:g})")
    barra = fig.colorbar(malla, ax=ax, pad=0.01, shrink=0.6, anchor=(0, 1))
    barra.set_label("B toroidal (adim.)  ·  rojo: +, azul: −", color=TEXTO_2)
    ax[1].plot(años, actividad, color=NARANJA, linewidth=1.8)
    ax[1].set_title("Actividad simulada: ⟨B²⟩ en latitudes |λ| < 40° (análogo al número de manchas)")
    ax[1].set_xlabel(f"Años (escalado: ciclo magnético = {AÑOS_CICLO_MAGNETICO:g} años)")
    ax[1].grid(color=REJILLA, linewidth=0.6)
    fig.savefig(FIG / "fig5_mariposa_modelo.png", dpi=150)

    emitir("dinamo_fin", periodo=P, anios_por_unidad=escala,
           lat_max=float(lat_max.max()), lat_min=float(lat_max.min()))
    print(f"D = {a.D:g}  ·  periodo = {P:.3f} tiempos de difusión  ·  "
          f"migración: {lat_max.max():.0f}° -> {lat_max.min():.0f}°  ·  "
          f"figura: figuras/fig5_mariposa_modelo.png")


if __name__ == "__main__":
    main()
