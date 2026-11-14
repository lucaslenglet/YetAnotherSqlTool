# Run by the postgres image when it creates the database (see startEntraPostgres in
# test/support/containers.mjs). Makes this PostgreSQL take Microsoft Entra ID sign-ins the way
# Azure Database for PostgreSQL does, as far as a client can tell:
#   - TLS is available, with a certificate made here for this container only;
#   - the roles of Entra identities are members of azure_ad_user (Azure's own name for that
#     group); they must use TLS and send their password, which is their access token, as is.
# Azure validates the token it receives. Here a role's password is simply set to the token the
# test expects for it, which checks the same thing on the client side: who sends which bytes.

openssl req -new -x509 -days 30 -nodes -newkey rsa:2048 \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$PGDATA/server.key" -out "$PGDATA/server.crt" 2>/dev/null
chmod 600 "$PGDATA/server.key"
echo "ssl = on" >> "$PGDATA/postgresql.conf"

# Read from top to bottom, the first matching line decides.
cat > "$PGDATA/pg_hba.conf" <<'EOF'
local     all  all             trust
hostnossl all  +azure_ad_user  all  reject
hostssl   all  +azure_ad_user  all  password
host      all  all             all  scram-sha-256
EOF

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOF'
CREATE ROLE azure_ad_user NOLOGIN;
-- A second database: the Object Explorer opens one connection per database.
CREATE DATABASE sales;
EOF
