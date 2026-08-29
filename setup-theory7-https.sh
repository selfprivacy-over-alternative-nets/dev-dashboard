#!/usr/bin/env bash
# setup-theory7-https.sh
# Idempotent: geeft je lokale SelfPrivacy-VM een vertrouwd https-adres dat op
# ELK wifi/netwerk werkt, gratis en zonder verlopende certificaten.
#
# Aanpak: lokale mkcert-CA (vertrouwd in system + Firefox) -> leaf-cert voor
# $DOMAIN -> kleine Caddy reverse-proxy op 127.0.0.1:443 die doorstuurt naar de
# bestaande ssh-tunnel ($UPSTREAM, VM:443 met self-signed cert). Naam -> 127.0.0.1
# via /etc/hosts. Loopback verandert nooit met je netwerk.
#
# Veilig om vaker te draaien: elke stap is idempotent (guard/skip).
# Herbruikbaar: pas DOMAIN/UPSTREAM aan of geef ze mee als env-var.
set -euo pipefail

DOMAIN="${DOMAIN:-theory7.weersurf.nl}"
UPSTREAM="${UPSTREAM:-127.0.0.1:8443}"      # bestaande ssh-tunnel -> VM:443
BIN="$HOME/.local/bin"
CERTDIR="$HOME/.local/share/theory7-tls"
CFGDIR="$HOME/.config/theory7"
CADDYFILE="$CFGDIR/Caddyfile"
UNIT="$HOME/.config/systemd/user/theory7-https.service"

log(){ printf '\033[1;34m==>\033[0m %s\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }

mkdir -p "$BIN" "$CERTDIR" "$CFGDIR" "$(dirname "$UNIT")"
export PATH="$BIN:$PATH"

# 0. sanity: draait de tunnel? (upstream moet bereikbaar zijn)
if ! curl -sk --max-time 5 -o /dev/null "https://$UPSTREAM/"; then
  echo "WAARSCHUWING: $UPSTREAM antwoordt niet. Staat de ssh-tunnel naar de VM aan?" >&2
fi

# 1. mkcert-binary (geen sudo: naar ~/.local/bin)
if ! have mkcert; then
  log "mkcert downloaden -> $BIN"
  curl -fsSL -o "$BIN/mkcert" "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
  chmod +x "$BIN/mkcert"
fi

# 2. certutil (Firefox-trust) — enige apt-install, alleen als het ontbreekt
if ! have certutil; then
  log "libnss3-tools installeren (sudo) — nodig om de CA in Firefox te vertrouwen"
  sudo apt-get update -qq && sudo apt-get install -y -qq libnss3-tools
fi

# 3. lokale CA in system- én Firefox-trust zetten (mkcert is zelf idempotent)
log "Lokale CA installeren in system- en Firefox-trust"
mkcert -install

# 4. leaf-certificaat voor het domein (alleen (her)maken als afwezig/bijna verlopen)
if [ ! -f "$CERTDIR/cert.pem" ] || ! openssl x509 -checkend 604800 -noout -in "$CERTDIR/cert.pem" >/dev/null 2>&1; then
  log "Certificaat maken voor $DOMAIN"
  mkcert -cert-file "$CERTDIR/cert.pem" -key-file "$CERTDIR/key.pem" "$DOMAIN"
fi

# 5. naam -> 127.0.0.1 in /etc/hosts (idempotent)
if ! grep -qE "^[0-9.]+[[:space:]]+$DOMAIN([[:space:]]|\$)" /etc/hosts; then
  log "$DOMAIN -> 127.0.0.1 toevoegen aan /etc/hosts (sudo)"
  echo "127.0.0.1 $DOMAIN" | sudo tee -a /etc/hosts >/dev/null
fi

# 6. caddy-binary (geen sudo: naar ~/.local/bin)
if ! have caddy; then
  log "caddy downloaden -> $BIN"
  curl -fsSL -o "$BIN/caddy" "https://caddyserver.com/api/download?os=linux&arch=amd64"
  chmod +x "$BIN/caddy"
fi

# 7. caddy mag poort 443 binden zonder root (idempotent)
if ! getcap "$(command -v caddy)" 2>/dev/null | grep -q cap_net_bind_service; then
  log "setcap zodat caddy poort 443 mag binden (sudo)"
  sudo setcap 'cap_net_bind_service=+ep' "$(command -v caddy)"
fi

# 8. Caddyfile: TLS termineren met de mkcert-cert, doorsturen naar de VM
cat > "$CADDYFILE" <<EOF
{
	admin off
	auto_https off
}
https://$DOMAIN {
	bind 127.0.0.1
	tls $CERTDIR/cert.pem $CERTDIR/key.pem
	reverse_proxy $UPSTREAM {
		transport http {
			tls
			tls_insecure_skip_verify
		}
	}
}
EOF
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null

# 9. als user-service draaien (idempotent; herstart bij reboot met linger)
cat > "$UNIT" <<EOF
[Unit]
Description=theory7 local HTTPS reverse-proxy (Caddy)
After=network.target

[Service]
ExecStart=$(command -v caddy) run --config $CADDYFILE --adapter caddyfile
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now theory7-https.service
log "Tip: 'sudo loginctl enable-linger $USER' laat de proxy ook draaien zonder ingelogde sessie."

# 10. verifiëren
sleep 1
log "Verifiëren..."
if curl -s --max-time 8 -o /dev/null -w 'HTTP %{http_code}, TLS-verify: %{ssl_verify_result} (0=OK)\n' "https://$DOMAIN/"; then
  log "KLAAR — open https://$DOMAIN in Firefox (geen waarschuwing)."
else
  echo "Verificatie faalde — check 'systemctl --user status theory7-https' en de tunnel." >&2
fi
