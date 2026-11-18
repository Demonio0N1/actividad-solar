"""Envía el progreso de los scripts a la página en vivo (`npm run dev` o `npm start`).

Cada script envuelve su trabajo en `ejecucion(...)`. Mientras corre:
  - todo lo que se imprime con print() aparece en la consola de la página;
  - `progreso(...)`, `emitir(...)` mandan datos estructurados (descargas, cuadros del dínamo);
  - al terminar se marca como "ok" o "error".

Si el servidor no está corriendo, el envío se desactiva en silencio y el script
funciona exactamente igual que sin la página.

Dirección y token del servidor, en este orden de prioridad:
  1. variables de entorno SOLAR_VIVO_URL y SOLAR_VIVO_TOKEN;
  2. el archivo .solar_vivo.json en la raíz del proyecto ({"url": ..., "token": ...}),
     que crea setup_sun.sh en el servidor;
  3. por defecto, http://localhost:5173 sin token (servidor de desarrollo).
"""

import atexit
import json
import os
import queue
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path


def _configuracion() -> tuple[str, str | None]:
    archivo = Path(__file__).resolve().parents[1] / ".solar_vivo.json"
    datos = {}
    if archivo.exists():
        try:
            datos = json.loads(archivo.read_text())
        except (OSError, ValueError):
            datos = {}
    url = os.environ.get("SOLAR_VIVO_URL") or datos.get("url") or "http://localhost:5173"
    token = os.environ.get("SOLAR_VIVO_TOKEN") or datos.get("token")
    return url.rstrip("/") + "/api/eventos", token


URL, _TOKEN = _configuracion()

_cola: queue.Queue = queue.Queue()
_activo = True
_ejecucion = {"id": None, "script": None}
_hilo = None


def _enviar(lote: list[dict]) -> bool:
    global _activo
    try:
        cabeceras = {"Content-Type": "application/json"}
        if _TOKEN:
            cabeceras["Authorization"] = f"Bearer {_TOKEN}"
        req = urllib.request.Request(URL, data=json.dumps(lote).encode(), method="POST", headers=cabeceras)
        urllib.request.urlopen(req, timeout=2).close()
        return True
    except urllib.error.HTTPError as e:
        _activo = False
        if e.code == 401:
            print("[en vivo] el servidor rechazó el token: revise .solar_vivo.json", file=sys.__stderr__)
        return False
    except OSError:
        _activo = False  # sin servidor: no se vuelve a intentar en esta ejecución
        return False


def _trabajador() -> None:
    while True:
        lote = [_cola.get()]
        # Agrupa lo que haya en cola para enviar menos peticiones
        while len(lote) < 500:
            try:
                lote.append(_cola.get_nowait())
            except queue.Empty:
                break
        if _activo:
            _enviar(lote)
        for _ in lote:
            _cola.task_done()


def id_ejecucion() -> str | None:
    """Identificador de la ejecución en curso (el mismo que ve la página)."""
    return _ejecucion["id"]


def conectado() -> bool:
    """True si el servidor de la página respondió (o aún no se ha probado)."""
    return _activo


def emitir(tipo: str, **datos) -> None:
    """Envía un evento a la página. No bloquea."""
    if not _activo or _ejecucion["id"] is None:
        return
    _cola.put({"ejecucion": _ejecucion["id"], "script": _ejecucion["script"],
               "tipo": tipo, "t": time.time() * 1000, **datos})


def progreso(clave: str, hecho: float, total: float | None = None, etiqueta: str = "", unidad: str = "") -> None:
    """Barra de progreso identificada por `clave` (por ejemplo, un archivo).

    `unidad="bytes"` hace que la página muestre MB en vez de un conteo."""
    emitir("progreso", clave=clave, hecho=hecho, total=total, etiqueta=etiqueta, unidad=unidad)


class _Espejo:
    """Copia lo que se escribe en stdout/stderr hacia la página, línea por línea."""

    def __init__(self, original, nivel: str):
        self.original, self.nivel, self._buf = original, nivel, ""

    def write(self, texto: str) -> int:
        self.original.write(texto)
        self._buf += texto
        while "\n" in self._buf:
            linea, self._buf = self._buf.split("\n", 1)
            if linea.strip():
                emitir("log", texto=linea, nivel=self.nivel)
        return len(texto)

    def flush(self) -> None:
        self.original.flush()

    def __getattr__(self, nombre):
        return getattr(self.original, nombre)


def _vaciar(timeout: float = 3.0) -> None:
    fin = time.time() + timeout
    while _cola.unfinished_tasks and time.time() < fin:
        time.sleep(0.02)


@contextmanager
def ejecucion(script: str, argumentos: dict | None = None):
    """Marca el inicio y fin de una ejecución y refleja la salida en la página."""
    global _hilo
    if _hilo is None:
        _hilo = threading.Thread(target=_trabajador, daemon=True)
        _hilo.start()
        atexit.register(_vaciar)
    # Prueba de conexión corta antes de empezar, para no acumular eventos sin destino
    _ejecucion.update(id=uuid.uuid4().hex[:10], script=script)
    inicio = time.time()
    emitir("inicio", argumentos=argumentos or {})
    _vaciar(2.0)
    if _activo:
        print(f"[en vivo] enviando a {URL.rsplit('/api', 1)[0]}")
    out, err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _Espejo(out, "info"), _Espejo(err, "error")
    try:
        yield
    except BaseException as e:
        if isinstance(e, SystemExit) and e.code in (0, None):
            emitir("fin", estado="ok", duracion=time.time() - inicio)
        else:
            detalle = str(e) if isinstance(e, SystemExit) else "".join(traceback.format_exception_only(e)).strip()
            emitir("fin", estado="error", duracion=time.time() - inicio, error=detalle)
        raise
    else:
        emitir("fin", estado="ok", duracion=time.time() - inicio)
    finally:
        sys.stdout, sys.stderr = out, err
        _vaciar()
