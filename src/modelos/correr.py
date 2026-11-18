"""Corre los modelos del laboratorio.

Uso:
  python src/modelos/correr.py --listar                       catálogo de modelos (JSON)
  python src/modelos/correr.py --validar --modelo parker --parametros '{"D": -1000}'
  python src/modelos/correr.py --modelo estocastico --parametros '{"ruido": 0.8}'
  python src/modelos/correr.py --modelo parker --publicar     corre y publica en la página
  python src/modelos/correr.py --publicado                    vuelve a correr el modelo publicado

Cada corrida se guarda en data/modelos/corridas/<id>.json (se conservan las 50 últimas).
Publicar copia el resultado a data/processed/modelo_publicado.json, que es lo que muestra la
página pública, y guarda su configuración en data/modelos/publicado.json para que la
actualización diaria la repita.
"""

import argparse
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # para importar en_vivo y modelos

from en_vivo import conectado, ejecucion, emitir, id_ejecucion  # noqa: E402
from modelos import latitud, vanderpol  # noqa: E402
from modelos.catalogo import MODELOS, ecuacion, exportar, validar  # noqa: E402

RAIZ = Path(__file__).resolve().parents[2]
CORRIDAS = RAIZ / "data" / "modelos" / "corridas"
CONFIG_PUBLICADO = RAIZ / "data" / "modelos" / "publicado.json"
PUBLICADO = RAIZ / "data" / "processed" / "modelo_publicado.json"
MAX_CORRIDAS = 50
MAX_CUADROS_GUARDADOS = 500


def correr_latitud(modelo: str, p: dict, pausa: float) -> dict:
    n = int(p["n"])
    lat = np.round(90 - np.degrees(np.linspace(0, np.pi, n)), 3)
    emitir("modelo_config", modelo=modelo, nombre=MODELOS[modelo]["nombre"], geometria="latitud", n=n,
           t_max=p["t_max"], cuadros=p["cuadros"], lat=lat.tolist(), parametros=p, ecuacion=ecuacion(modelo, p))

    def al_guardar(t, B, f):
        if not conectado():
            return
        emitir("modelo_cuadro", tiempo=round(t, 5), B=np.round(B, 4).tolist(), ruido=round(float(f), 4))
        if pausa > 0:
            time.sleep(pausa)

    integrador = latitud.integrar_dos_capas if modelo == "transporte" else latitud.integrar
    r = integrador(p, al_guardar)
    a = latitud.analizar(r)
    paso = max(1, -(-len(r.tiempos) // MAX_CUADROS_GUARDADOS))
    return {
        "tipo": "latitud",
        "lat": lat.tolist(),
        "tiempos": np.round(r.tiempos[::paso], 5).tolist(),
        "B": np.round(r.B[::paso], 4).tolist(),
        "actividad": np.round(a["actividad"][::paso], 5).tolist(),
        "t_max": p["t_max"],
        "resumen": a["resumen"],
    }


def correr_serie(modelo: str, p: dict, pausa: float) -> dict:
    emitir("modelo_config", modelo=modelo, nombre=MODELOS[modelo]["nombre"], geometria="serie",
           anio_inicio=p["anio_inicio"], anio_fin=p["anio_fin"], parametros=p, ecuacion=ecuacion(modelo, p))

    def al_guardar(anios, S):
        if not conectado():
            return
        emitir("modelo_cuadro", anios=anios, S=S)
        if pausa > 0:
            time.sleep(pausa)

    r = vanderpol.integrar(p, al_guardar)
    return {
        "tipo": "serie",
        "anios": np.round(r["anios"], 3).tolist(),
        "S": np.round(r["S"], 2).tolist(),
        "resumen": vanderpol.analizar(r, p),
    }


def guardar(corrida: dict) -> Path:
    CORRIDAS.mkdir(parents=True, exist_ok=True)
    ruta = CORRIDAS / f"{corrida['id']}.json"
    ruta.write_text(json.dumps(corrida, ensure_ascii=False, separators=(",", ":")))
    antiguas = sorted(CORRIDAS.glob("*.json"), key=lambda r: r.stat().st_mtime)
    for vieja in antiguas[:-MAX_CORRIDAS]:
        vieja.unlink()
    return ruta


def publicar(ruta_corrida: Path) -> None:
    corrida = json.loads(ruta_corrida.read_text())
    PUBLICADO.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PUBLICADO.parent.mkdir(parents=True, exist_ok=True)
    tmp = PUBLICADO.with_suffix(".tmp")
    shutil.copyfile(ruta_corrida, tmp)
    tmp.replace(PUBLICADO)
    CONFIG_PUBLICADO.write_text(json.dumps({
        "modelo": corrida["modelo"], "parametros": corrida["parametros"],
        "corrida": corrida["id"], "publicado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }, ensure_ascii=False, indent=1))
    print(f"Publicado en la página: {corrida['nombre']} (corrida {corrida['id']})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--listar", action="store_true")
    ap.add_argument("--validar", action="store_true")
    ap.add_argument("--modelo", default="parker")
    ap.add_argument("--parametros", default="{}", help="JSON con los parámetros")
    ap.add_argument("--pausa", type=float, default=None, help="segundos entre cuadros enviados a la página")
    ap.add_argument("--publicar", action="store_true", help="publicar el resultado en la página")
    ap.add_argument("--publicado", action="store_true", help="repetir el modelo publicado y volver a publicarlo")
    ap.add_argument("--publicar-corrida", metavar="ID", help="publicar una corrida ya guardada")
    a = ap.parse_args()

    if a.listar:
        print(json.dumps(exportar(), ensure_ascii=False))
        return
    if a.publicar_corrida:
        if not a.publicar_corrida.isalnum():
            raise SystemExit("Identificador de corrida inválido.")
        ruta = CORRIDAS / f"{a.publicar_corrida}.json"
        if not ruta.exists():
            raise SystemExit(f"No existe la corrida {a.publicar_corrida}.")
        publicar(ruta)
        return

    try:
        crudos = json.loads(a.parametros)
    except json.JSONDecodeError:
        raise SystemExit("--parametros no es un JSON válido.") from None
    if a.publicado:
        config = json.loads(CONFIG_PUBLICADO.read_text()) if CONFIG_PUBLICADO.exists() else {}
        a.modelo, crudos, a.publicar = config.get("modelo", "parker"), config.get("parametros", {}), True
        a.pausa = 0.0

    p, errores = validar(a.modelo, crudos)
    if a.validar:
        print(json.dumps({"ok": not errores, "errores": errores, "parametros": p,
                          "ecuacion": ecuacion(a.modelo, p) if not errores else None}, ensure_ascii=False))
        return
    if errores:
        raise SystemExit("Parámetros inválidos: " + "; ".join(f"{k}: {v}" for k, v in errores.items()))

    tipo = MODELOS[a.modelo]["tipo"]
    pausa = a.pausa if a.pausa is not None else (0.004 if tipo == "latitud" else 0.01)
    with ejecucion("modelo", {"modelo": a.modelo, **{k: v for k, v in p.items() if k != "cuadros"}}):
        inicio = time.time()
        datos = correr_latitud(a.modelo, p, pausa) if tipo == "latitud" else correr_serie(a.modelo, p, pausa)
        corrida = {
            "id": id_ejecucion() or datetime.now().strftime("%Y%m%d%H%M%S"),
            "modelo": a.modelo, "nombre": MODELOS[a.modelo]["nombre"], "numero": MODELOS[a.modelo]["numero"],
            "fecha": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "parametros": p, "ecuacion": ecuacion(a.modelo, p),
            "referencias": MODELOS[a.modelo]["referencias"],
            "duracion_s": round(time.time() - inicio, 1),
            **datos,
        }
        ruta = guardar(corrida)
        emitir("modelo_fin", corrida=corrida["id"], geometria=tipo, resumen=corrida["resumen"])
        print(f"{corrida['nombre']}: listo en {corrida['duracion_s']} s · corrida {corrida['id']}")
        r = corrida["resumen"]
        if tipo == "latitud":
            print(f"  periodo {r['periodo']} · migración {r['migracion']['desde']}° → {r['migracion']['hasta']}° "
                  f"({r['migracion']['direccion']}) · amplitud {r['amplitud']}")
        else:
            print(f"  modelo: {r['modelo']}")
            if "observado" in r:
                print(f"  observado: {r['observado']}")
        if a.publicar:
            publicar(ruta)


if __name__ == "__main__":
    main()
