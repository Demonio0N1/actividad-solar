"""Solucionadores de dínamos de campo medio en latitud (modelos 1, 2 y 3).

`integrar` (modelos 1 y 2) resuelve, en colatitud θ ∈ [0, π] y unidades adimensionales
(tiempo en R²/η_t):

    ∂A/∂t = f(t) α(θ) Q(B) + η L(A) − c_r A
    ∂B/∂t = D Ω[A]         + η L(B) − c_r B

con opciones para cada término:
  α(θ)   fórmula libre (expresiones.py)                   por defecto cos θ sin² θ
  Q(B)   quenching: ninguno | algebraico B/(1+B²) | fuerte B/(1+B⁴)
  Ω[A]   simplificado sinθ ∂A/∂θ | completo ∂(sinθ A)/∂θ
  L      laplaciano simplificado ∂²/∂θ² | esférico ∂² + cotθ ∂ − 1/sin²θ
  f(t)   1 + ε ξ(t), con ξ un ruido de Ornstein–Uhlenbeck de tiempo de correlación τ (modelo 2)
  paridad: dipolar | cuadrupolar | libre

Con las opciones por defecto reproduce exactamente src/modelo_dinamo.py.
`integrar_dos_capas` (modelo 3) agrega la circulación meridional; ver su documentación.
"""

from dataclasses import dataclass

import numpy as np

from .expresiones import perfil


@dataclass
class Resultado:
    theta: np.ndarray
    tiempos: np.ndarray
    B: np.ndarray        # (cuadros, n)
    ruido: np.ndarray    # f(t) en cada cuadro (1 si no hay ruido)


def integrar(p: dict, al_guardar=None) -> Resultado:
    n = int(p["n"])
    th = np.linspace(0, np.pi, n)
    h = th[1] - th[0]
    s = np.sin(th)
    with np.errstate(divide="ignore"):
        cot = np.where(s > 0, np.cos(th) / np.where(s > 0, s, 1), 0.0)
        inv_s2 = np.where(s > 0, 1 / np.where(s > 0, s, 1) ** 2, 0.0)

    eta = float(p["eta"])
    alfa = perfil(p["alfa"], th)

    # Paso de tiempo: estabilidad del esquema explícito de difusión (FTCS: dt ≤ h²/2η)
    dt = 0.2 * h * h / max(eta, 1e-9)
    pasos = int(p["t_max"] / dt)
    cada = max(1, pasos // int(p["cuadros"]))

    rng = np.random.default_rng(int(p["semilla"]))
    A = 1e-3 * s * (1 + 0.1 * rng.standard_normal(n))
    B = np.zeros(n)

    eps = float(p.get("ruido", 0) or 0)
    tau = float(p.get("tau_ruido", 0.05) or 0.05)
    xi = 0.0
    rng_ruido = np.random.default_rng(int(p["semilla"]) + 1)

    quench = p["quenching"]
    lap_esf = p["laplaciano"] == "esferico"
    omega_completo = p["omega"] == "completo"
    paridad = p["paridad"]
    D, cr = float(p["D"]), float(p["decaimiento"])

    def laplaciano(X):
        L = np.zeros(n)
        L[1:-1] = (X[2:] - 2 * X[1:-1] + X[:-2]) / h**2
        if lap_esf:
            L[1:-1] += cot[1:-1] * (X[2:] - X[:-2]) / (2 * h) - inv_s2[1:-1] * X[1:-1]
        return L

    def derivada(X):
        d = np.zeros(n)
        d[1:-1] = (X[2:] - X[:-2]) / (2 * h)
        return d

    ts, Bs, fs = [], [], []
    for k in range(pasos):
        if eps:
            xi += -xi * dt / tau + np.sqrt(2 * dt / tau) * rng_ruido.standard_normal()
        f = 1 + eps * xi
        if quench == "algebraico":
            Q = B / (1 + B * B)
        elif quench == "fuerte":
            Q = B / (1 + B**4)
        else:
            Q = B
        omega = derivada(s * A) if omega_completo else s * derivada(A)
        dAdt = f * alfa * Q + eta * laplaciano(A) - cr * A
        dBdt = D * omega + eta * laplaciano(B) - cr * B
        A, B = A + dt * dAdt, B + dt * dBdt
        if paridad == "dipolar":
            A = 0.5 * (A + A[::-1])
            B = 0.5 * (B - B[::-1])
        elif paridad == "cuadrupolar":
            A = 0.5 * (A - A[::-1])
            B = 0.5 * (B + B[::-1])
        A[[0, -1]] = 0.0
        B[[0, -1]] = 0.0
        if not np.isfinite(B).all() or np.abs(B).max() > 1e8:
            raise FloatingPointError("La solución diverge (el campo crece sin límite). "
                                     "Use quenching, un |D| menor o una resolución menor.")
        if k % cada == 0:
            ts.append(k * dt)
            Bs.append(B.copy())
            fs.append(f)
            if al_guardar is not None:
                al_guardar(k * dt, B, f)
    return Resultado(th, np.array(ts), np.array(Bs), np.array(fs))


def periodo(t: np.ndarray, serie: np.ndarray) -> float:
    cruces = t[np.where(np.diff(np.sign(serie)) != 0)[0]]
    return float(2 * np.mean(np.diff(cruces))) if len(cruces) > 3 else float("nan")


def analizar(r: Resultado) -> dict:
    """Periodo, migración, actividad y variabilidad de los ciclos."""
    lat = 90 - np.degrees(r.theta)
    mitad = len(r.tiempos) // 2
    j30 = int(np.argmin(np.abs(lat - 30)))
    P = periodo(r.tiempos[mitad:], r.B[mitad:, j30])
    norte = lat > 0
    lm = lat[norte][np.argmax(np.abs(r.B[mitad:, norte]), axis=1)]
    pasos = np.diff(lm)
    pasos = pasos[np.abs(pasos) < 5]
    direccion = None
    if len(pasos) and np.abs(r.B[mitad:]).max() > 1e-6:
        direccion = "ecuador" if pasos.mean() < 0 else "polos"
    bajas = np.abs(lat) < 40
    actividad = (r.B[:, bajas] ** 2).mean(axis=1)
    resumen = {
        "periodo": None if np.isnan(P) else round(P, 4),
        "anios_por_unidad": None if np.isnan(P) else round(22.0 / P, 3),
        "amplitud": round(float(np.abs(r.B[-max(1, len(r.tiempos) // 4):]).max()), 4),
        "migracion": {"desde": round(float(lm.max()), 1), "hasta": round(float(lm.min()), 1),
                      "direccion": direccion},
        "oscila": not np.isnan(P),
    }
    # Variabilidad: altura de cada máximo de actividad en la segunda mitad (ciclos de manchas)
    a = actividad[mitad:]
    if resumen["oscila"] and len(a) > 5:
        picos = [a[i] for i in range(1, len(a) - 1) if a[i] >= a[i - 1] and a[i] > a[i + 1] and a[i] > 0.3 * a.max()]
        if len(picos) >= 3:
            resumen["ciclos"] = len(picos)
            resumen["variacion_maximos"] = round(float(np.std(picos) / np.mean(picos)), 3)
    return {"resumen": resumen, "actividad": actividad, "latitud": lat}


def integrar_dos_capas(p: dict, al_guardar=None) -> Resultado:
    """Modelo 3: transporte de flujo simplificado, con dos capas en latitud.

    Representa el circuito de la circulación meridional: en la superficie el campo poloidal A_s
    viaja hacia los polos; se hunde hacia la base (A_b) con un tiempo τ_r; en la base la corriente
    vuelve hacia el ecuador y arrastra A_b y el campo toroidal B, que la rotación genera a partir
    de A_b. El efecto α (tipo Babcock–Leighton) crea A_s en la superficie a partir de B.

        ∂A_s/∂t = α(θ) Q(B) + η L(A_s) − c_r A_s − ∂(v_s A_s)/∂θ,   v_s = −v₀ v(θ)  (hacia los polos)
        ∂A_b/∂t = (A_s − A_b)/τ_r + η L(A_b) − c_r A_b − ∂(v_b A_b)/∂θ,   v_b = +v₀ v(θ)  (al ecuador)
        ∂B/∂t   = D sinθ ∂A_b/∂θ + η L(B) − c_r B − ∂(v_b B)/∂θ
    """
    n = int(p["n"])
    th = np.linspace(0, np.pi, n)
    h = th[1] - th[0]
    s = np.sin(th)
    eta, cr, D = float(p["eta"]), float(p["decaimiento"]), float(p["D"])
    tau_r = float(p["tau_r"])
    alfa = perfil(p["alfa"], th)
    forma = perfil(p.get("perfil_v", "sin(2*t)"), th)
    v_b = float(p["v0"]) * forma
    v_s = -v_b
    vmax = max(np.abs(v_b).max(), 1e-9)
    dt = min(0.2 * h * h / max(eta, 1e-9), 0.4 * h / vmax, 0.5 * tau_r)
    pasos = int(p["t_max"] / dt)
    cada = max(1, pasos // int(p["cuadros"]))
    quench = p["quenching"]
    paridad = p["paridad"]

    rng = np.random.default_rng(int(p["semilla"]))
    As = 1e-3 * s * (1 + 0.1 * rng.standard_normal(n))
    Ab = np.zeros(n)
    B = np.zeros(n)

    def lap(X):
        L = np.zeros(n)
        L[1:-1] = (X[2:] - 2 * X[1:-1] + X[:-2]) / h**2
        return L

    def der(X):
        d = np.zeros(n)
        d[1:-1] = (X[2:] - X[:-2]) / (2 * h)
        return d

    def adv(X, v):
        # −∂(vX)/∂θ en forma de flujo, tomando X del lado de donde viene la corriente (estable)
        vc = 0.5 * (v[1:] + v[:-1])
        flujo = np.where(vc > 0, vc * X[:-1], vc * X[1:])
        out = np.zeros(n)
        out[1:-1] = -(flujo[1:] - flujo[:-1]) / h
        return out

    ts, Bs = [], []
    for k in range(pasos):
        Q = B / (1 + B * B) if quench == "algebraico" else (B / (1 + B**4) if quench == "fuerte" else B)
        As, Ab, B = (As + dt * (alfa * Q + eta * lap(As) - cr * As + adv(As, v_s)),
                     Ab + dt * ((As - Ab) / tau_r + eta * lap(Ab) - cr * Ab + adv(Ab, v_b)),
                     B + dt * (D * s * der(Ab) + eta * lap(B) - cr * B + adv(B, v_b)))
        if paridad == "dipolar":
            As, Ab, B = 0.5 * (As + As[::-1]), 0.5 * (Ab + Ab[::-1]), 0.5 * (B - B[::-1])
        elif paridad == "cuadrupolar":
            As, Ab, B = 0.5 * (As - As[::-1]), 0.5 * (Ab - Ab[::-1]), 0.5 * (B + B[::-1])
        for X in (As, Ab, B):
            X[[0, -1]] = 0.0
        if not np.isfinite(B).all() or np.abs(B).max() > 1e8:
            raise FloatingPointError("La solución diverge (el campo crece sin límite). "
                                     "Use quenching, un |D| menor o una corriente más lenta.")
        if k % cada == 0:
            ts.append(k * dt)
            Bs.append(B.copy())
            if al_guardar is not None:
                al_guardar(k * dt, B, 1.0)
    return Resultado(th, np.array(ts), np.array(Bs), np.ones(len(ts)))
