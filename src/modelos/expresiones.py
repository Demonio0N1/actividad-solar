"""Evaluación segura de fórmulas escritas en el laboratorio, como el perfil α(θ).

Solo se aceptan números, las variables θ (`t` o `theta`, colatitud en radianes) y
λ (`lat`, latitud en radianes), las constantes `pi` y `e`, los operadores + − * / **
y las funciones de la tabla FUNCIONES. Cualquier otra cosa (atributos, índices,
nombres desconocidos, llamadas a otras funciones) se rechaza antes de evaluar, así
que una fórmula no puede ejecutar código.

    >>> import numpy as np
    >>> perfil("cos(t) * sin(t)**2", np.linspace(0, np.pi, 5)).round(3)
    array([ 0.   ,  0.354,  0.   , -0.354, -0.   ])
"""

import ast

import numpy as np

FUNCIONES = {
    "sin": np.sin, "cos": np.cos, "tan": np.tan, "exp": np.exp, "sqrt": np.sqrt,
    "abs": np.abs, "tanh": np.tanh, "log": np.log, "sign": np.sign,
}
CONSTANTES = {"pi": np.pi, "e": np.e}
VARIABLES = {"t", "theta", "lat"}
LARGO_MAXIMO = 200

_OPERADORES = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd)


class ExpresionInvalida(ValueError):
    pass


def _validar(nodo: ast.AST) -> None:
    for n in ast.walk(nodo):
        if isinstance(n, (ast.Expression, ast.Load) + _OPERADORES):
            continue
        if isinstance(n, (ast.BinOp, ast.UnaryOp)):
            continue
        if isinstance(n, ast.Constant):
            if not isinstance(n.value, (int, float)) or isinstance(n.value, bool):
                raise ExpresionInvalida("Solo se permiten números.")
            continue
        if isinstance(n, ast.Name):
            if n.id not in VARIABLES and n.id not in CONSTANTES and n.id not in FUNCIONES:
                raise ExpresionInvalida(f"Nombre desconocido: {n.id}. Use t (θ), lat (λ), pi, e "
                                        f"o una función: {', '.join(FUNCIONES)}.")
            continue
        if isinstance(n, ast.Call):
            if not isinstance(n.func, ast.Name) or n.func.id not in FUNCIONES:
                raise ExpresionInvalida("Solo se pueden llamar las funciones " + ", ".join(FUNCIONES) + ".")
            if len(n.args) != 1 or n.keywords:
                raise ExpresionInvalida(f"{n.func.id}() recibe exactamente un argumento.")
            continue
        raise ExpresionInvalida(f"Elemento no permitido en la fórmula: {type(n).__name__}.")


class _AFlotante(ast.NodeTransformer):
    """Convierte los enteros en flotantes: 9**9**9 se desborda a infinito al instante en vez de
    calcular un entero gigantesco (que podría colgar el servidor)."""

    def visit_Constant(self, nodo: ast.Constant) -> ast.Constant:
        if isinstance(nodo.value, int) and not isinstance(nodo.value, bool):
            return ast.copy_location(ast.Constant(float(nodo.value)), nodo)
        return nodo


def compilar(texto: str):
    """Valida la fórmula y devuelve una función f(theta) -> arreglo."""
    texto = (texto or "").strip().replace("^", "**").replace("θ", "t").replace("λ", "lat")
    if not texto:
        raise ExpresionInvalida("La fórmula está vacía.")
    if len(texto) > LARGO_MAXIMO:
        raise ExpresionInvalida(f"La fórmula es demasiado larga (máximo {LARGO_MAXIMO} caracteres).")
    try:
        arbol = ast.parse(texto, mode="eval")
    except SyntaxError as e:
        raise ExpresionInvalida(f"Error de sintaxis: {e.msg}.") from None
    _validar(arbol)
    arbol = ast.fix_missing_locations(_AFlotante().visit(arbol))
    codigo = compile(arbol, "<fórmula>", "eval")

    def f(theta: np.ndarray) -> np.ndarray:
        entorno = {"t": theta, "theta": theta, "lat": np.pi / 2 - theta, **CONSTANTES, **FUNCIONES}
        try:
            with np.errstate(all="ignore"):
                valor = eval(codigo, {"__builtins__": {}}, entorno)  # noqa: S307 (árbol validado arriba)
        except (ArithmeticError, ValueError, TypeError) as e:
            raise ExpresionInvalida(f"No se pudo evaluar la fórmula: {e}.") from None
        return np.broadcast_to(np.asarray(valor, dtype=float), theta.shape).copy()

    return f


def perfil(texto: str, theta: np.ndarray) -> np.ndarray:
    """Evalúa la fórmula en la malla y exige valores finitos."""
    valores = compilar(texto)(theta)
    if not np.all(np.isfinite(valores)):
        raise ExpresionInvalida("La fórmula da valores infinitos o indefinidos en algún punto de la malla "
                                "(por ejemplo, una división por sin(t) en los polos).")
    if np.abs(valores).max() > 1e6:
        raise ExpresionInvalida("La fórmula da valores demasiado grandes (más de 10⁶).")
    return valores
