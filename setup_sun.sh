#!/usr/bin/env bash
# setup_sun.sh: lleva "Monitoreo del Sol en vivo" a un servidor Linux y deja la página web
# funcionando como servicio, con los datos y el modelo publicado actualizándose solos cada día.
#
# 1) En su computador, empaquete la carpeta (sin .venv ni node_modules, que no sirven en Linux):
#      ./setup_sun.sh empaquetar
#      scp actividad_solar_AAAAMMDD.tar.gz usuario@servidor:~
#
# 2) En el servidor (Ubuntu/Debian o Fedora/RHEL/Rocky), como usuario normal con sudo:
#      mkdir actividad_solar && tar xzf actividad_solar_*.tar.gz -C actividad_solar
#      cd actividad_solar
#      ./setup_sun.sh instalar                       # página en http://IP-del-servidor:8080
#      ./setup_sun.sh instalar --dominio sol.ejemplo.org   # con nginx en el puerto 80
#      ./setup_sun.sh instalar --tailscale           # HTTPS solo dentro de su red Tailscale
#      ./setup_sun.sh instalar --funnel              # HTTPS pública en internet, vía Tailscale Funnel
#
# Opciones de "instalar":
#   --puerto N        puerto del servidor de la página (por defecto 8080)
#   --dominio NOMBRE  configura nginx como proxy para ese dominio (la página queda en el puerto 80)
#   --tailscale       publica la página con "tailscale serve" (https://MAQUINA.RED.ts.net), visible
#                     solo para los equipos de su red Tailscale; el puerto no queda abierto en la red local
#   --funnel          como --tailscale, pero la página queda pública en internet (Tailscale Funnel)
#   --hora HH:MM      hora UTC de la actualización diaria de datos (por defecto 06:30)
#   --sin-paquetes    no instala paquetes del sistema (Python, Node, nginx); solo los verifica
#   --sin-servicio    no crea servicios de systemd (para probar a mano con: npm start)
#   --sin-datos       no descarga datos aunque falten
#
# Otros comandos (en el servidor):
#   ./setup_sun.sh estado        estado del servicio, de la actualización diaria y de la página
#   ./setup_sun.sh actualizar    descarga y procesa los datos ahora (se ve en vivo en el laboratorio)
#   ./setup_sun.sh contrasena    crea o cambia la contraseña del laboratorio (/laboratorio)
#   ./setup_sun.sh reiniciar     reinicia la página (por ejemplo, después de copiar código nuevo)
#   ./setup_sun.sh actualizar-codigo   trae la última versión de GitHub (git pull), instala lo que
#                                haga falta y reinicia la página. No toca datos ni contraseña.
#   ./setup_sun.sh desinstalar   quita los servicios y la configuración de nginx (no borra datos)

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICIO="actividad-solar"
NODE_MINIMO="20.19.0"   # lo exige Vite 8 (package.json, "engines")
PYTHON_MINIMO="3.10"

PUERTO=8080
DOMINIO=""
HORA="06:30"
CON_PAQUETES=1
CON_SERVICIO=1
CON_DATOS=1
CON_TAILSCALE=0
CON_FUNNEL=0

# ─────────────────────────── utilidades ───────────────────────────
if [[ -t 1 ]]; then
  NEGRITA=$'\e[1m'; VERDE=$'\e[32m'; AMARILLO=$'\e[33m'; ROJO=$'\e[31m'; NORMAL=$'\e[0m'
else
  NEGRITA=""; VERDE=""; AMARILLO=""; ROJO=""; NORMAL=""
fi
paso()   { printf '\n%s==> %s%s\n' "$NEGRITA" "$*" "$NORMAL"; }
ok()     { printf '%s  ✓ %s%s\n' "$VERDE" "$*" "$NORMAL"; }
aviso()  { printf '%s  ! %s%s\n' "$AMARILLO" "$*" "$NORMAL" >&2; }
fallar() { printf '%s  ✗ %s%s\n' "$ROJO" "$*" "$NORMAL" >&2; exit 1; }
existe() { command -v "$1" >/dev/null 2>&1; }

# Compara versiones "a.b.c": devuelve 0 si $1 >= $2
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

# Elige el primer Python ≥ 3.10 disponible (en RHEL/Rocky 9, python3 es la 3.9)
PYTHON=""
elegir_python() {
  local p
  for p in python3.13 python3.12 python3.11 python3.10 python3; do
    if existe "$p" && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
      PYTHON="$p"; return 0
    fi
  done
  PYTHON=""; return 1
}

SUDO=""
necesita_sudo() {
  if [[ $EUID -eq 0 ]]; then SUDO=""; return; fi
  existe sudo || fallar "Hace falta sudo para este paso (o ejecútelo como root)."
  SUDO="sudo"
}

# Imprime el bloque de comentarios del comienzo del archivo
ayuda() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

# ─────────────────────────── empaquetar ───────────────────────────
empaquetar() {
  local salida
  salida="$RAIZ/actividad_solar_$(date +%Y%m%d).tar.gz"
  paso "Empaquetando $RAIZ"
  # COPYFILE_DISABLE evita que el tar de macOS agregue archivos ._ con metadatos
  COPYFILE_DISABLE=1 tar -czf "$salida" -C "$RAIZ" \
    --exclude='./.venv' --exclude='./node_modules' --exclude='./dist' \
    --exclude='./.solar_vivo.json' --exclude='./.solar_admin.json' --exclude='./actividad_solar_*.tar.gz' \
    --exclude='./data/modelos/corridas' \
    --exclude='.DS_Store' --exclude='__pycache__' --exclude='*.part' --exclude='./.git' \
    .
  ok "Paquete: $(basename "$salida") ($(du -h "$salida" | cut -f1))"
  cat <<EOF

Siguientes pasos:
  scp "$(basename "$salida")" usuario@servidor:~
  ssh usuario@servidor
  mkdir actividad_solar && tar xzf $(basename "$salida") -C actividad_solar
  cd actividad_solar && ./setup_sun.sh instalar

Alternativa sin paquete (copia directa, la repite cuando cambie el código):
  rsync -av --exclude .venv --exclude node_modules --exclude dist --exclude .solar_vivo.json \\
    --exclude .solar_admin.json --exclude data --exclude figuras \\
    "$RAIZ/" usuario@servidor:actividad_solar/
EOF
}

# ─────────────────────────── instalar ───────────────────────────
instalar_paquetes() {
  paso "Paquetes del sistema"
  necesita_sudo
  local node_ok=0
  if existe node && version_ge "$(node -p 'process.versions.node')" "$NODE_MINIMO"; then node_ok=1; fi

  if existe apt-get; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y python3 python3-venv python3-pip curl ca-certificates
    if [[ $node_ok -eq 0 ]]; then
      echo "  Instalando Node.js 22 desde NodeSource (repositorio oficial de paquetes de Node)…"
      curl -fsSL https://deb.nodesource.com/setup_22.x | ${SUDO:+$SUDO -E} bash -
      $SUDO apt-get install -y nodejs
    fi
    [[ -n "$DOMINIO" ]] && $SUDO apt-get install -y nginx
  elif existe dnf || existe yum; then
    local gestor; gestor="$(existe dnf && echo dnf || echo yum)"
    $SUDO "$gestor" install -y python3 python3-pip curl ca-certificates
    elegir_python || $SUDO "$gestor" install -y python3.11 python3.11-pip
    if [[ $node_ok -eq 0 ]]; then
      echo "  Instalando Node.js 22 desde NodeSource (repositorio oficial de paquetes de Node)…"
      curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
      $SUDO "$gestor" install -y nodejs
    fi
    [[ -n "$DOMINIO" ]] && $SUDO "$gestor" install -y nginx
  else
    fallar "No encontré apt ni dnf. Instale Python ≥ $PYTHON_MINIMO y Node ≥ $NODE_MINIMO y use --sin-paquetes."
  fi
  ok "Paquetes instalados"
}

verificar_versiones() {
  paso "Verificando versiones"
  elegir_python || fallar "Hace falta Python ≥ $PYTHON_MINIMO (python3 es $(python3 -V 2>&1 | cut -d' ' -f2 || echo 'inexistente'))."
  "$PYTHON" -c "import venv, ensurepip" 2>/dev/null \
    || fallar "Falta el módulo venv de Python (en Debian/Ubuntu: sudo apt install python3-venv)."
  existe node || fallar "Falta Node.js (≥ $NODE_MINIMO)."
  existe npm || fallar "Falta npm."
  version_ge "$(node -p 'process.versions.node')" "$NODE_MINIMO" \
    || fallar "Node $(node -v) es muy antiguo: hace falta ≥ $NODE_MINIMO."
  ok "$("$PYTHON" -V) ($PYTHON), Node $(node -v), npm $(npm -v)"
}

instalar_python() {
  paso "Entorno de Python (.venv)"
  [[ -x "$RAIZ/.venv/bin/python" ]] || "$PYTHON" -m venv "$RAIZ/.venv"
  "$RAIZ/.venv/bin/pip" install --quiet --upgrade pip
  "$RAIZ/.venv/bin/pip" install --quiet -r "$RAIZ/requirements.txt"
  ok "Dependencias de requirements.txt instaladas"
}

instalar_node() {
  paso "Dependencias de Node (node_modules)"
  cd "$RAIZ"
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
  ok "npm listo"
}

configurar_token() {
  paso "Token para que los scripts envíen su progreso a la página"
  local archivo="$RAIZ/.solar_vivo.json" token=""
  if [[ -f "$archivo" ]]; then
    token="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("token",""))' "$archivo" 2>/dev/null || true)"
  fi
  local mensaje=".solar_vivo.json actualizado (se conserva el token)"
  if [[ -z "$token" ]]; then
    token="$("$PYTHON" -c 'import secrets; print(secrets.token_hex(24))')"
    mensaje=".solar_vivo.json creado con un token nuevo (solo lo lee su usuario)"
  fi
  ( umask 077; printf '{"url": "http://127.0.0.1:%s", "token": "%s"}\n' "$PUERTO" "$token" > "$archivo" )
  ok "$mensaje"
}

configurar_contrasena() {
  paso "Contraseña del laboratorio"
  if [[ -f "$RAIZ/.solar_admin.json" ]]; then
    ok "Ya existe (para cambiarla: ./setup_sun.sh contrasena)"
    return
  fi
  cd "$RAIZ"
  if [[ -t 0 ]]; then
    echo "  El laboratorio (/laboratorio) permite correr y publicar modelos. Elija una contraseña (mínimo 8 caracteres)."
    until node web/servidor/contrasena.js; do echo "  Intente de nuevo."; done
  else
    # Sin terminal interactiva: se genera una al azar y se muestra una sola vez
    local clave
    clave="$("$PYTHON" -c 'import secrets; print(secrets.token_urlsafe(12))')"
    printf '%s' "$clave" | node web/servidor/contrasena.js >/dev/null
    aviso "Contraseña generada para el laboratorio: $clave"
    aviso "Anótela ahora; no se vuelve a mostrar. Para cambiarla: ./setup_sun.sh contrasena"
  fi
  ok "Contraseña guardada (solo su hash, en .solar_admin.json)"
}

preparar_datos() {
  if [[ -f "$RAIZ/data/processed/fulguraciones.csv" && -f "$RAIZ/figuras/fig5_mariposa_modelo.png" ]]; then
    paso "Datos"; ok "Ya están en data/processed/ (se actualizarán cada día)"
    if [[ ! -f "$RAIZ/data/processed/modelo_publicado.json" ]]; then
      (cd "$RAIZ" && npm run modelo-publicado) && ok "Modelo publicado inicial calculado"
    fi
    return
  fi
  if [[ $CON_DATOS -eq 0 ]]; then
    paso "Datos"; aviso "Faltan datos y se pidió --sin-datos: la página mostrará secciones vacías."
    return
  fi
  paso "Descargando y procesando datos (~30 MB, unos minutos)"
  cd "$RAIZ"
  npm run diario
  ok "Datos y figuras listos"
}

compilar() {
  paso "Compilando la página (dist/)"
  cd "$RAIZ"
  npm run build
  ok "Página compilada"
}

escribir_unidad() {  # $1 = nombre, contenido por stdin
  $SUDO tee "/etc/systemd/system/$1" >/dev/null
}

crear_servicios() {
  if [[ $CON_SERVICIO -eq 0 ]]; then
    paso "Servicio"; aviso "Sin servicio (--sin-servicio). Para probar: cd $RAIZ && PORT=$PUERTO npm start"
    return
  fi
  if ! existe systemctl || [[ ! -d /run/systemd/system ]]; then
    paso "Servicio"; aviso "Este sistema no usa systemd. Inicie la página con: cd $RAIZ && PORT=$PUERTO npm start"
    return
  fi
  paso "Servicios de systemd"
  necesita_sudo
  local usuario node npm host
  usuario="$(id -un)"
  node="$(command -v node)"
  npm="$(command -v npm)"
  host="0.0.0.0"
  # Con nginx o Tailscale Serve delante, solo ellos llegan al puerto
  [[ -n "$DOMINIO" || $CON_TAILSCALE -eq 1 ]] && host="127.0.0.1"

  escribir_unidad "$SERVICIO.service" <<EOF
[Unit]
Description=Actividad Solar: página web en vivo
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$usuario
WorkingDirectory=$RAIZ
Environment=PORT=$PUERTO
Environment=HOST=$host
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart="$node" "$RAIZ/web/servidor/produccion.js"
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  escribir_unidad "$SERVICIO-actualizar.service" <<EOF
[Unit]
Description=Actividad Solar: descarga y procesa los datos del día y recalcula el modelo publicado
After=network-online.target $SERVICIO.service
Wants=network-online.target

[Service]
Type=oneshot
User=$usuario
WorkingDirectory=$RAIZ
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart="$npm" run diario
EOF

  escribir_unidad "$SERVICIO-actualizar.timer" <<EOF
[Unit]
Description=Actividad Solar: actualización diaria de datos a las $HORA UTC

[Timer]
OnCalendar=*-*-* $HORA:00 UTC
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "$SERVICIO.service" >/dev/null
  $SUDO systemctl restart "$SERVICIO.service"
  $SUDO systemctl enable --now "$SERVICIO-actualizar.timer" >/dev/null
  ok "Servicio $SERVICIO activo; actualización diaria a las $HORA UTC"
}

configurar_nginx() {
  [[ -z "$DOMINIO" ]] && return
  paso "nginx para $DOMINIO"
  necesita_sudo
  existe nginx || fallar "nginx no está instalado (quite --sin-paquetes o instálelo)."
  local destino
  if [[ -d /etc/nginx/sites-available ]]; then
    destino="/etc/nginx/sites-available/$SERVICIO"
  else
    destino="/etc/nginx/conf.d/$SERVICIO.conf"
  fi
  # Plantilla entre comillas: nginx usa $host, etc.; solo se reemplazan DOMINIO y PUERTO
  sed -e "s/__DOMINIO__/$DOMINIO/g" -e "s/__PUERTO__/$PUERTO/g" <<'EOF' | $SUDO tee "$destino" >/dev/null
server {
    listen 80;
    listen [::]:80;
    server_name __DOMINIO__;
    client_max_body_size 1m;

    # Los eventos de los scripts llegan directo a 127.0.0.1:__PUERTO__, nunca desde afuera
    location = /api/eventos { return 403; }

    # Conexión en vivo (Server-Sent Events): sin búfer y con tiempo de espera largo
    location = /api/stream {
        proxy_pass http://127.0.0.1:__PUERTO__;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:__PUERTO__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
  if [[ -d /etc/nginx/sites-enabled ]]; then
    $SUDO ln -sf "$destino" "/etc/nginx/sites-enabled/$SERVICIO"
  fi
  # SELinux (Fedora/RHEL): permitir que nginx se conecte al puerto local
  if existe getenforce && [[ "$(getenforce)" == "Enforcing" ]]; then
    $SUDO setsebool -P httpd_can_network_connect 1
  fi
  $SUDO nginx -t
  $SUDO systemctl enable --now nginx >/dev/null
  $SUDO systemctl reload nginx
  ok "nginx sirve http://$DOMINIO"
}

URL_TAILSCALE=""
# Se revisa al comienzo, para no descubrir el problema después de toda la instalación
verificar_tailscale() {
  [[ $CON_TAILSCALE -eq 1 ]] || return 0
  existe tailscale || fallar "Tailscale no está instalado. Instálelo y conéctese primero:
      curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
  tailscale status >/dev/null 2>&1 || fallar "Tailscale no está conectado. Ejecute: sudo tailscale up"
}

configurar_tailscale() {
  [[ $CON_TAILSCALE -eq 1 ]] || return 0
  paso "Tailscale Serve"
  necesita_sudo
  # HTTPS hacia el puerto local de la página: "serve" solo para la red Tailscale, "funnel" para internet
  local modo="serve" alcance="solo para su red Tailscale"
  if [[ $CON_FUNNEL -eq 1 ]]; then modo="funnel"; alcance="pública en internet"; fi
  if ! $SUDO tailscale "$modo" --bg --https=443 "http://127.0.0.1:$PUERTO"; then
    fallar "tailscale $modo falló. Revise en https://login.tailscale.com/admin/dns que MagicDNS y los
      certificados HTTPS estén activados$( [[ $CON_FUNNEL -eq 1 ]] && echo ', y que su política permita Funnel (el error de arriba trae el enlace)'),
      y vuelva a ejecutar el mismo comando."
  fi
  URL_TAILSCALE="https://$(tailscale status --json | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  ok "Página publicada en $URL_TAILSCALE ($alcance)"
}

comprobar() {
  paso "Comprobando la página"
  local url="http://127.0.0.1:$PUERTO" intento
  for intento in $(seq 1 20); do
    if curl -fsS -o /dev/null "$url/api/archivos" 2>/dev/null; then
      ok "La página responde en $url"
      return 0
    fi
    sleep 0.5
  done
  aviso "La página no responde en $url. Revise: journalctl -u $SERVICIO -n 50"
  return 1
}

resumen() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  cat <<EOF

${NEGRITA}Listo.${NORMAL}
  Página:        $( if [[ -n "$URL_TAILSCALE" ]]; then echo "$URL_TAILSCALE"; elif [[ -n "$DOMINIO" ]]; then echo "http://$DOMINIO"; else echo "http://${ip:-IP-del-servidor}:$PUERTO"; fi )
  Secciones:     /  (en vivo) · /modelo · /meteorologia · /laboratorio (con contraseña)
  Datos:         se actualizan cada día a las $HORA UTC (./setup_sun.sh estado)
  Registros:     journalctl -u $SERVICIO -f
EOF
  if [[ -n "$URL_TAILSCALE" && $CON_FUNNEL -eq 1 ]]; then
    echo "  Acceso:        pública en internet. La primera vez puede tardar unos minutos en verse."
    echo "                 Para volverla privada: sudo tailscale funnel --https=443 off && ./setup_sun.sh instalar --tailscale"
  elif [[ -n "$URL_TAILSCALE" ]]; then
    echo "  Acceso:        solo su red Tailscale. Para hacerla pública: ./setup_sun.sh instalar --funnel"
  elif [[ -n "$DOMINIO" ]]; then
    echo "  HTTPS:         sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d $DOMINIO"
  else
    echo "  Firewall:      si usa ufw, abra el puerto con: sudo ufw allow $PUERTO/tcp"
  fi
  echo "  Laboratorio:   correr y publicar modelos, ver ejecuciones y consola (con contraseña)."
}

instalar() {
  if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then
    fallar "Ejecútelo sin sudo (./setup_sun.sh instalar). El script pide sudo solo cuando lo necesita."
  fi
  [[ $EUID -eq 0 ]] && aviso "Está como root: la página correrá como root. Es mejor un usuario normal con sudo."
  [[ "$(uname -s)" == "Linux" ]] || aviso "Este comando está pensado para un servidor Linux; en $(uname -s) se omiten los servicios."
  [[ "$PUERTO" =~ ^[0-9]+$ ]] || fallar "Puerto inválido: $PUERTO"
  [[ "$HORA" =~ ^[0-2][0-9]:[0-5][0-9]$ ]] || fallar "Hora inválida: $HORA (use HH:MM)"
  [[ -z "$DOMINIO" || "$DOMINIO" =~ ^[A-Za-z0-9.-]+$ ]] || fallar "Dominio inválido: $DOMINIO"
  [[ -n "$DOMINIO" && $CON_TAILSCALE -eq 1 ]] && fallar "Use --dominio o --tailscale, no ambos."
  verificar_tailscale

  [[ $CON_PAQUETES -eq 1 && "$(uname -s)" == "Linux" ]] && instalar_paquetes
  verificar_versiones
  instalar_python
  instalar_node
  configurar_token
  configurar_contrasena
  preparar_datos
  compilar
  crear_servicios
  configurar_nginx
  configurar_tailscale
  if [[ $CON_SERVICIO -eq 1 ]] && existe systemctl && [[ -d /run/systemd/system ]]; then
    comprobar || true
  fi
  resumen
}

# ─────────────────────────── otros comandos ───────────────────────────
estado() {
  existe systemctl || fallar "systemctl no está disponible."
  systemctl --no-pager status "$SERVICIO.service" | head -n 5 || true
  echo
  systemctl --no-pager list-timers "$SERVICIO-actualizar.timer" || true
  echo
  echo "Última actualización de datos:"
  journalctl -u "$SERVICIO-actualizar.service" -n 5 --no-pager 2>/dev/null || true
}

actualizar() { cd "$RAIZ" && npm run diario; }

actualizar_codigo() {
  cd "$RAIZ"
  [[ -d .git ]] || fallar "Esta carpeta no es un repositorio de git. Vea el README: «Actualizar desde GitHub»."
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git status --short --untracked-files=no
    fallar "Hay cambios locales en archivos del repositorio (arriba). Guárdelos o descártelos (git checkout -- ARCHIVO) y repita."
  fi
  paso "Trayendo la última versión"
  local antes
  antes="$(git rev-parse HEAD)"
  git pull --ff-only
  if [[ "$(git rev-parse HEAD)" == "$antes" ]]; then
    ok "Ya estaba al día ($(git log -1 --format='%h %s'))"
    return
  fi
  git --no-pager log --oneline "$antes..HEAD"
  if ! git diff --quiet "$antes" HEAD -- requirements.txt; then
    paso "Dependencias de Python"
    "$RAIZ/.venv/bin/pip" install --quiet -r requirements.txt
    ok "requirements.txt instalado"
  fi
  if ! git diff --quiet "$antes" HEAD -- package.json package-lock.json; then
    paso "Dependencias de Node"
    npm ci --no-audit --no-fund
    ok "node_modules al día"
  fi
  if [[ $CON_SERVICIO -eq 1 ]] && systemctl list-unit-files "$SERVICIO.service" >/dev/null 2>&1; then
    reiniciar
  else
    npm run build
    ok "Página recompilada (no hay servicio de systemd: reinicie npm start a mano)"
  fi
}

contrasena() {
  cd "$RAIZ"
  existe node || fallar "Falta Node.js."
  node web/servidor/contrasena.js
}

reiniciar() {
  necesita_sudo
  cd "$RAIZ"
  npm run build
  $SUDO systemctl restart "$SERVICIO.service"
  ok "Página recompilada y reiniciada"
}

desinstalar() {
  necesita_sudo
  paso "Quitando servicios"
  $SUDO systemctl disable --now "$SERVICIO-actualizar.timer" "$SERVICIO.service" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/$SERVICIO.service" \
    "/etc/systemd/system/$SERVICIO-actualizar.service" "/etc/systemd/system/$SERVICIO-actualizar.timer"
  $SUDO systemctl daemon-reload
  if [[ -e "/etc/nginx/sites-enabled/$SERVICIO" || -e "/etc/nginx/sites-available/$SERVICIO" || -e "/etc/nginx/conf.d/$SERVICIO.conf" ]]; then
    $SUDO rm -f "/etc/nginx/sites-enabled/$SERVICIO" "/etc/nginx/sites-available/$SERVICIO" "/etc/nginx/conf.d/$SERVICIO.conf"
    existe nginx && $SUDO nginx -t && $SUDO systemctl reload nginx
  fi
  if existe tailscale && tailscale serve status 2>/dev/null | grep -q "127.0.0.1:"; then
    aviso "Tailscale sigue publicando un puerto local. Si era esta página: sudo tailscale funnel --https=443 off; sudo tailscale serve --https=443 off"
  fi
  ok "Servicios quitados. Los datos y el código siguen en $RAIZ"
}

# ─────────────────────────── main ───────────────────────────
comando="${1:-}"
[[ $# -gt 0 ]] && shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --puerto)       PUERTO="${2:?falta el número de puerto}"; shift 2 ;;
    --dominio)      DOMINIO="${2:?falta el dominio}"; shift 2 ;;
    --hora)         HORA="${2:?falta la hora HH:MM}"; shift 2 ;;
    --sin-paquetes) CON_PAQUETES=0; shift ;;
    --sin-servicio) CON_SERVICIO=0; shift ;;
    --sin-datos)    CON_DATOS=0; shift ;;
    --tailscale)    CON_TAILSCALE=1; shift ;;
    --funnel)       CON_TAILSCALE=1; CON_FUNNEL=1; shift ;;
    -h|--help)      ayuda; exit 0 ;;
    *)              fallar "Opción desconocida: $1 (vea ./setup_sun.sh --help)" ;;
  esac
done

case "$comando" in
  empaquetar)  empaquetar ;;
  instalar)    instalar ;;
  estado)      estado ;;
  actualizar)  actualizar ;;
  actualizar-codigo) actualizar_codigo ;;
  contrasena)  contrasena ;;
  reiniciar)   reiniciar ;;
  desinstalar) desinstalar ;;
  -h|--help|ayuda|"") ayuda ;;
  *) fallar "Comando desconocido: $comando (vea ./setup_sun.sh --help)" ;;
esac
