#!/bin/sh
set -eu
# Called by Certbot only after a successful renewal of this certificate.
lineage=${RENEWED_LINEAGE:-/etc/letsencrypt/live/dsh-marshal-ip}
[ "$lineage" = /etc/letsencrypt/live/dsh-marshal-ip ] || exit 0
openssl x509 -in "$lineage/fullchain.pem" -noout -checkend 3600 >/dev/null
install -o root -g caddy -m 0640 "$lineage/fullchain.pem" /etc/caddy/dsh-marshal/public-cert.next
install -o root -g caddy -m 0640 "$lineage/privkey.pem" /etc/caddy/dsh-marshal/public-key.next
mv /etc/caddy/dsh-marshal/public-cert.next /etc/caddy/dsh-marshal/public-cert.pem
mv /etc/caddy/dsh-marshal/public-key.next /etc/caddy/dsh-marshal/public-key.pem
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
