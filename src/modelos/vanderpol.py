"""Modelo 4: el ciclo solar como oscilador de Van der Pol con ruido.

Un modelo de bajo orden (sin latitud): x(t) representa el campo toroidal global, que oscila
con el ciclo magnético de ~22 años; el número de manchas es proporcional a x². En tiempo
adimensional τ = ω t, con ω = 2π / P:

    x'' − μ (1 − x²) x' + x = σ ξ(τ)          (ξ: ruido blanco)
    S(t) = s₀ x(t)²

μ controla la no linealidad (μ → 0: oscilación sinusoidal; μ grande: oscilación de relajación,
con subidas rápidas) y σ el ruido, que hace que cada ciclo tenga distinta amplitud y duración.
Mininni, Gómez y Mindlin (2000) mostraron que un oscilador de este tipo reproduce varias
propiedades estadísticas del registro de manchas.

Se integra con Euler–Maruyama y se compara con el número de manchas mensual de SILSO
(media de 13 meses).
"""

from pathlib import Path

import numpy as np
import pandas as pd

RAIZ = Path(__file__).resolve().parents[2]


def integrar(p: dict, al_guardar=None) -> dict:
    P = float(p["periodo_magnetico"])
    mu, sigma, s0 = float(p["mu"]), float(p["ruido"]), float(p["escala"])
    anio0, anio1 = float(p["anio_inicio"]), float(p["anio_fin"])
    omega = 2 * np.pi / P
    dt_anios = 0.005
    dtau = omega * dt_anios
    pasos = int((anio1 - anio0) / dt_anios)
    rng = np.random.default_rng(int(p["semilla"]))
    x, y = float(p["x0"]), 0.0
    cada = max(1, int(round((1 / 12) / dt_anios)))  # un punto por mes
    anios, xs = [], []
    lote_a, lote_s = [], []
    for k in range(pasos):
        dW = np.sqrt(dtau) * rng.standard_normal()
        x, y = x + y * dtau, y + (mu * (1 - x * x) * y - x) * dtau + sigma * dW
        if not np.isfinite(x) or abs(x) > 1e6:
            raise FloatingPointError("La solución diverge. Reduzca el ruido σ o la no linealidad μ.")
        if k % cada == 0:
            a = anio0 + k * dt_anios
            anios.append(a)
            xs.append(x)
            if al_guardar is not None:
                lote_a.append(round(a, 3))
                lote_s.append(round(s0 * x * x, 2))
                if len(lote_a) >= 12:  # se envía un año por vez
                    al_guardar(lote_a, lote_s)
                    lote_a, lote_s = [], []
    if al_guardar is not None and lote_a:
        al_guardar(lote_a, lote_s)
    anios = np.array(anios)
    xs = np.array(xs)
    return {"anios": anios, "x": xs, "S": s0 * xs**2}


def maximos(anios: np.ndarray, serie: np.ndarray, separacion: float = 7.0) -> tuple[np.ndarray, np.ndarray]:
    """Máximos de ciclo: el mayor valor en cada ventana, separados al menos `separacion` años."""
    idx = []
    for i in np.argsort(serie)[::-1]:
        if all(abs(anios[i] - anios[j]) >= separacion for j in idx):
            idx.append(i)
    idx = sorted(i for i in idx if serie[i] > 0.25 * serie.max())
    return anios[idx], serie[idx]


def estadisticas(anios: np.ndarray, serie: np.ndarray) -> dict:
    t, v = maximos(anios, serie)
    if len(t) < 3:
        return {"ciclos": int(len(t))}
    return {
        "ciclos": int(len(t)),
        "periodo_medio": round(float(np.mean(np.diff(t))), 2),
        "periodo_desv": round(float(np.std(np.diff(t))), 2),
        "maximo_medio": round(float(np.mean(v)), 1),
        "variacion_maximos": round(float(np.std(v) / np.mean(v)), 3),
    }


def observado() -> tuple[np.ndarray, np.ndarray] | None:
    """Número de manchas mensual suavizado (13 meses) de data/processed/manchas_mensuales.csv."""
    ruta = RAIZ / "data" / "processed" / "manchas_mensuales.csv"
    if not ruta.exists():
        return None
    m = pd.read_csv(ruta).dropna(subset=["manchas_13m"])
    return m["anio_decimal"].to_numpy(), m["manchas_13m"].to_numpy()


def analizar(r: dict, p: dict) -> dict:
    resumen = {"modelo": estadisticas(r["anios"], r["S"])}
    obs = observado()
    if obs is not None:
        a, s = obs
        m = (a >= r["anios"][0]) & (a <= r["anios"][-1])
        resumen["observado"] = estadisticas(a[m], s[m])
        # Correlación mes a mes con lo observado (con ruido, se espera baja: el modelo no predice fases)
        modelo_interp = np.interp(a[m], r["anios"], r["S"])
        if m.sum() > 24:
            resumen["correlacion"] = round(float(np.corrcoef(modelo_interp, s[m])[0, 1]), 3)
    return resumen
