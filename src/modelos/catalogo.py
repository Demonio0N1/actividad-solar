"""Catálogo de modelos del laboratorio: parámetros, límites, ecuación y referencias.

Es la única fuente de verdad: la página del laboratorio arma el formulario a partir de
`exportar()` y el servidor valida con `validar()` antes de correr nada. Los límites
mantienen cada simulación por debajo de ~1 minuto en una Raspberry Pi 5.
"""

import ast
from datetime import date

from .expresiones import ExpresionInvalida, compilar

OPCIONES_QUENCHING = [
    {"valor": "algebraico", "etiqueta": "Algebraico: B/(1+B²)"},
    {"valor": "fuerte", "etiqueta": "Fuerte: B/(1+B⁴)"},
    {"valor": "ninguno", "etiqueta": "Ninguno (lineal; puede divergir)"},
]
OPCIONES_PARIDAD = [
    {"valor": "dipolar", "etiqueta": "Dipolar (ley de Hale)"},
    {"valor": "cuadrupolar", "etiqueta": "Cuadrupolar"},
    {"valor": "libre", "etiqueta": "Libre (sin imponer)"},
]


def _num(clave, etiqueta, defecto, minimo, maximo, paso, ayuda="", entero=False):
    return {"clave": clave, "etiqueta": etiqueta, "tipo": "entero" if entero else "numero",
            "defecto": defecto, "min": minimo, "max": maximo, "paso": paso, "ayuda": ayuda}


def _opcion(clave, etiqueta, defecto, opciones, ayuda=""):
    return {"clave": clave, "etiqueta": etiqueta, "tipo": "opcion", "defecto": defecto,
            "opciones": opciones, "ayuda": ayuda}


def _formula(clave, etiqueta, defecto, ayuda=""):
    return {"clave": clave, "etiqueta": etiqueta, "tipo": "formula", "defecto": defecto, "ayuda": ayuda}


AYUDA_FORMULA = ("Use t para θ (colatitud) o lat para λ (latitud), en radianes; "
                 "funciones sin, cos, tan, exp, sqrt, abs, tanh, log, sign; ^ o ** para potencias.")

COMUNES_LATITUD = [
    _num("D", "Número de dínamo D", -2000, -50000, 50000, 100,
         "Intensidad del ciclo α–Ω. Negativo: migración al ecuador; positivo: hacia los polos."),
    _formula("alfa", "Perfil del efecto α(θ)", "cos(t)*sin(t)**2", AYUDA_FORMULA),
    _opcion("quenching", "Saturación de α (quenching)", "algebraico", OPCIONES_QUENCHING),
    _opcion("paridad", "Paridad entre hemisferios", "dipolar", OPCIONES_PARIDAD),
    _num("eta", "Difusión en latitud η", 1.0, 0.1, 5.0, 0.1, "Multiplica el término ∂²/∂θ²."),
    _num("decaimiento", "Pérdida radial cᵣ", 1.0, 0.0, 20.0, 0.1, "Tasa de los términos −A y −B."),
    _num("t_max", "Duración (tiempos de difusión)", 8.0, 1.0, 40.0, 0.5),
    _opcion("n", "Resolución en latitud", 121, [
        {"valor": 61, "etiqueta": "61 puntos (3°)"}, {"valor": 121, "etiqueta": "121 puntos (1.5°)"},
        {"valor": 181, "etiqueta": "181 puntos (1°)"}]),
    _num("semilla", "Semilla aleatoria", 0, 0, 999999, 1, "Misma semilla, mismo resultado.", entero=True),
]

MODELOS = {
    "parker": {
        "nombre": "Dínamo αΩ de Parker",
        "numero": 1,
        "tipo": "latitud",
        "descripcion": "La onda de dínamo de Parker en 1D: la rotación diferencial y la convección "
                       "helicoidal regeneran el campo en un ciclo que migra en latitud. Es el modelo "
                       "descrito en detalle en la página Modelo.",
        "referencias": ["Parker (1955), ApJ 122, 293", "Stix (1972), A&A 20, 9", "Charbonneau (2020), LRSP 17, 4"],
        "parametros": COMUNES_LATITUD + [
            _opcion("omega", "Término Ω", "simplificado", [
                {"valor": "simplificado", "etiqueta": "Simplificado: sinθ ∂A/∂θ"},
                {"valor": "completo", "etiqueta": "Completo: ∂(sinθ A)/∂θ"}]),
            _opcion("laplaciano", "Laplaciano en θ", "simplificado", [
                {"valor": "simplificado", "etiqueta": "Simplificado: ∂²/∂θ²"},
                {"valor": "esferico", "etiqueta": "Esférico: ∂² + cotθ ∂ − 1/sin²θ"}]),
        ],
    },
    "estocastico": {
        "nombre": "Dínamo αΩ con fluctuaciones",
        "numero": 2,
        "tipo": "latitud",
        "descripcion": "El modelo 1 con el efecto α perturbado por un ruido aleatorio con memoria "
                       "(Ornstein–Uhlenbeck), que representa la naturaleza turbulenta de la convección. "
                       "Los ciclos dejan de ser idénticos: cambian de altura, como en el Sol.",
        "referencias": ["Choudhuri (1992), A&A 253, 277", "Ossendrijver (2003), A&ARv 11, 287"],
        "parametros": [p if p["clave"] != "t_max" else {**p, "defecto": 24.0} for p in COMUNES_LATITUD] + [
            _num("ruido", "Amplitud del ruido ε", 0.6, 0.0, 3.0, 0.05, "Fluctuación relativa de α."),
            _num("tau_ruido", "Memoria del ruido τ", 0.05, 0.005, 1.0, 0.005,
                 "Tiempo de correlación, en tiempos de difusión (0.05 ≈ 1 año)."),
            _opcion("omega", "Término Ω", "simplificado", [
                {"valor": "simplificado", "etiqueta": "Simplificado: sinθ ∂A/∂θ"},
                {"valor": "completo", "etiqueta": "Completo: ∂(sinθ A)/∂θ"}]),
            _opcion("laplaciano", "Laplaciano en θ", "simplificado", [
                {"valor": "simplificado", "etiqueta": "Simplificado: ∂²/∂θ²"},
                {"valor": "esferico", "etiqueta": "Esférico: ∂² + cotθ ∂ − 1/sin²θ"}]),
        ],
    },
    "transporte": {
        "nombre": "Transporte de flujo (dos capas)",
        "numero": 3,
        "tipo": "latitud",
        "descripcion": "Agrega la circulación meridional: el campo poloidal viaja hacia los polos en "
                       "la superficie, se hunde y vuelve hacia el ecuador por la base, donde la rotación "
                       "lo convierte en toroidal. La velocidad de la corriente fija el periodo y baja "
                       "las latitudes de las bandas, más cerca de las manchas reales.",
        "referencias": ["Choudhuri, Schüssler y Dikpati (1995), A&A 303, L29",
                        "Dikpati y Charbonneau (1999), ApJ 518, 508"],
        "parametros": [
            {**p, "defecto": -6000} if p["clave"] == "D" else (
                {**p, "defecto": 12.0} if p["clave"] == "t_max" else p)
            for p in COMUNES_LATITUD
        ] + [
            _num("v0", "Velocidad de la corriente v₀", 12.0, 0.0, 60.0, 0.5,
                 "En radianes por tiempo de difusión. Más rápida: ciclo más corto."),
            _formula("perfil_v", "Perfil de la corriente v(θ)", "sin(2*t)",
                     "Positivo = hacia el ecuador en la base (y hacia los polos en la superficie). " + AYUDA_FORMULA),
            _num("tau_r", "Tiempo de hundimiento τᵣ", 0.1, 0.01, 2.0, 0.01,
                 "Cuánto tarda el campo poloidal en pasar de la superficie a la base."),
        ],
    },
    "vanderpol": {
        "nombre": "Oscilador de Van der Pol",
        "numero": 4,
        "tipo": "serie",
        "descripcion": "Un modelo de bajo orden, sin latitud: el campo global oscila como un "
                       "oscilador no lineal con ruido y el número de manchas es proporcional a x². "
                       "Se compara directamente con el registro de manchas de SILSO desde 1749.",
        "referencias": ["Mininni, Gómez y Mindlin (2000), Phys. Rev. Lett. 85, 5476"],
        "parametros": [
            _num("periodo_magnetico", "Periodo magnético P (años)", 21.0, 10.0, 40.0, 0.1,
                 "El ciclo de manchas dura aproximadamente P/2."),
            _num("mu", "No linealidad μ", 1.0, 0.0, 10.0, 0.05,
                 "0: oscilación sinusoidal; grande: subidas bruscas (oscilación de relajación)."),
            _num("ruido", "Ruido σ", 0.6, 0.0, 3.0, 0.05, "Hace que cada ciclo sea distinto."),
            _num("escala", "Escala s₀ (manchas por x²)", 45.0, 1.0, 500.0, 1.0),
            _num("x0", "Condición inicial x₀", 1.0, -5.0, 5.0, 0.1),
            _num("anio_inicio", "Año inicial", 1749.0, 1749.0, 2020.0, 1.0),
            _num("semilla", "Semilla aleatoria", 0, 0, 999999, 1, "Misma semilla, mismo resultado.", entero=True),
        ],
    },
}


def exportar() -> dict:
    return {clave: {k: v for k, v in m.items()} for clave, m in MODELOS.items()}


def validar(modelo: str, crudos: dict | None) -> tuple[dict, dict]:
    """Devuelve (parámetros completos, errores por clave). Sin errores, se puede correr."""
    if modelo not in MODELOS:
        return {}, {"modelo": f"Modelo desconocido: {modelo}"}
    crudos = crudos or {}
    limpios, errores = {}, {}
    for d in MODELOS[modelo]["parametros"]:
        clave, valor = d["clave"], crudos.get(d["clave"], d["defecto"])
        try:
            if d["tipo"] in ("numero", "entero"):
                valor = float(valor)
                if d["tipo"] == "entero":
                    valor = int(round(valor))
                if not (d["min"] <= valor <= d["max"]):
                    raise ValueError(f"Debe estar entre {d['min']} y {d['max']}.")
            elif d["tipo"] == "opcion":
                validos = [o["valor"] for o in d["opciones"]]
                if valor not in validos and str(valor) in map(str, validos):
                    valor = validos[list(map(str, validos)).index(str(valor))]
                if valor not in validos:
                    raise ValueError("Opción no válida.")
            elif d["tipo"] == "formula":
                compilar(str(valor))
                valor = str(valor)
        except (ValueError, TypeError, ExpresionInvalida) as e:
            errores[clave] = str(e) if str(e) else "Valor no válido."
        limpios[clave] = valor
    # Valores fijos que no se exponen
    limpios.setdefault("cuadros", 1500)
    if modelo == "parker":
        limpios.setdefault("ruido", 0.0)
    if MODELOS[modelo]["tipo"] == "serie":
        hoy = date.today()
        limpios["anio_fin"] = hoy.year + (hoy.timetuple().tm_yday - 1) / 365.25
        if limpios.get("anio_inicio", 0) >= limpios["anio_fin"] - 30:
            errores["anio_inicio"] = "Deje al menos 30 años de simulación."
    return limpios, errores


# ─────────────────────────── ecuación en LaTeX ───────────────────────────
_FUNC_TEX = {"sin": r"\sin", "cos": r"\cos", "tan": r"\tan", "exp": r"\exp", "log": r"\log",
             "tanh": r"\tanh", "sign": r"\operatorname{sign}"}


def _tex(n: ast.AST) -> str:
    if isinstance(n, ast.Expression):
        return _tex(n.body)
    if isinstance(n, ast.Constant):
        v = n.value
        return str(int(v)) if float(v).is_integer() else f"{v:g}"
    if isinstance(n, ast.Name):
        return {"t": r"\theta", "theta": r"\theta", "lat": r"\lambda", "pi": r"\pi", "e": "e"}.get(n.id, n.id)
    if isinstance(n, ast.UnaryOp):
        return ("-" if isinstance(n.op, ast.USub) else "+") + _tex(n.operand)
    if isinstance(n, ast.Call):
        f, arg = n.func.id, _tex(n.args[0])
        if f == "sqrt":
            return rf"\sqrt{{{arg}}}"
        if f == "abs":
            return rf"\left|{arg}\right|"
        return rf"{_FUNC_TEX[f]}\left({arg}\right)"
    if isinstance(n, ast.BinOp):
        a, b = _tex(n.left), _tex(n.right)
        if isinstance(n.op, ast.Div):
            return rf"\frac{{{a}}}{{{b}}}"
        if isinstance(n.op, ast.Pow):
            # sin(θ)^2 se escribe \sin^2\theta, como en los textos
            if isinstance(n.left, ast.Call) and n.left.func.id in _FUNC_TEX and n.left.func.id != "sign":
                return rf"{_FUNC_TEX[n.left.func.id]}^{{{b}}}\left({_tex(n.left.args[0])}\right)"
            base = a if isinstance(n.left, (ast.Name, ast.Constant)) else rf"\left({a}\right)"
            return rf"{base}^{{{b}}}"
        if isinstance(n.op, ast.Mult):
            return rf"{a}\,{b}"
        sep = " + " if isinstance(n.op, ast.Add) else " - "
        return a + sep + b
    return "?"


def formula_tex(texto: str) -> str:
    try:
        texto = texto.strip().replace("^", "**").replace("θ", "t").replace("λ", "lat")
        return _tex(ast.parse(texto, mode="eval"))
    except (SyntaxError, KeyError, AttributeError):
        return r"\text{(fórmula inválida)}"


def ecuacion(modelo: str, p: dict) -> str:
    """Ecuación del modelo en LaTeX, según las opciones elegidas."""
    m = MODELOS[modelo]
    if m["tipo"] == "serie":
        return (r"\begin{aligned}"
                r"&\ddot{x} - \mu\,(1 - x^2)\,\dot{x} + x = \sigma\,\xi(\tau), \qquad \tau = \tfrac{2\pi}{P}\,t\\"
                r"&S(t) = s_0\, x(t)^2"
                rf"\qquad \mu = {p['mu']:g},\ \sigma = {p['ruido']:g},\ P = {p['periodo_magnetico']:g}\ \text{{años}}"
                r"\end{aligned}")
    Q = {"algebraico": r"\frac{B}{1+B^2}", "fuerte": r"\frac{B}{1+B^4}", "ninguno": "B"}[p["quenching"]]
    alfa = formula_tex(p["alfa"])
    if modelo == "transporte":
        v = formula_tex(p["perfil_v"])
        return (r"\begin{aligned}"
                rf"\partial_t A_s &= \alpha(\theta)\,{Q} + \eta\,\partial_\theta^2 A_s - c_r A_s + \partial_\theta(v A_s)\\"
                rf"\partial_t A_b &= \frac{{A_s - A_b}}{{\tau_r}} + \eta\,\partial_\theta^2 A_b - c_r A_b - \partial_\theta(v A_b)\\"
                rf"\partial_t B &= D\sin\theta\,\partial_\theta A_b + \eta\,\partial_\theta^2 B - c_r B - \partial_\theta(v B)\\"
                rf"\alpha(\theta) &= {alfa}, \qquad v(\theta) = v_0\,{v}"
                r"\end{aligned}")
    L = (r"\left(\partial_\theta^2 + \cot\theta\,\partial_\theta - \frac{1}{\sin^2\theta}\right)"
         if p.get("laplaciano") == "esferico" else r"\partial_\theta^2")
    omega = (r"D\,\partial_\theta(\sin\theta\,A)" if p.get("omega") == "completo"
             else r"D\sin\theta\,\partial_\theta A")
    f = r"\left(1 + \varepsilon\,\xi(t)\right)" if modelo == "estocastico" else ""
    return (r"\begin{aligned}"
            rf"\partial_t A &= {f}\,\alpha(\theta)\,{Q} + \eta\,{L} A - c_r A\\"
            rf"\partial_t B &= {omega} + \eta\,{L} B - c_r B\\"
            rf"\alpha(\theta) &= {alfa}"
            r"\end{aligned}")
