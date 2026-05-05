#!/usr/bin/env bash
# Bootstraps the observability stack (kube-prometheus-stack, ECK ELK,
# Tempo, OTel Collector) into the `observability` namespace. Idempotent
# — safe to re-run; each helm/kubectl call is upsert-shaped.
#
# Assumes:
#   - kubectl context is pointed at the target cluster (e.g. minikube)
#   - helm 3.x and kubectl are on PATH
#
# Reads no env vars. Run it; pipe stdout to a log if you want a record.

set -euo pipefail

cd "$(dirname "$0")/.."

NS=observability
TIMEOUT=10m

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# ─── Helm repos ────────────────────────────────────────────────────────────
say "Adding/refreshing Helm repos"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm repo add elastic https://helm.elastic.co >/dev/null
helm repo add grafana https://grafana.github.io/helm-charts >/dev/null
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts >/dev/null
helm repo update >/dev/null

# ─── Operators / charts ────────────────────────────────────────────────────
say "Creating namespace $NS"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

say "Installing ECK operator (elastic-system, cluster-wide)"
helm upgrade --install eck-operator elastic/eck-operator \
  --namespace elastic-system --create-namespace \
  -f k8s/observability/elastic/eck-operator.values.yaml
kubectl -n elastic-system rollout status statefulset/elastic-operator --timeout="$TIMEOUT"

say "Installing kube-prometheus-stack"
helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  --namespace "$NS" \
  -f k8s/observability/prometheus/kube-prometheus-stack.values.yaml
kubectl -n "$NS" rollout status deploy/kps-operator --timeout="$TIMEOUT"

# StatefulSets are created by the operator after its own rollout, so we
# wait for them to exist before waiting on their rollout.
say "Waiting for Prometheus + Alertmanager StatefulSets to materialise"
kubectl -n "$NS" wait --for=create statefulset/prometheus-kps-prometheus --timeout="$TIMEOUT"
kubectl -n "$NS" wait --for=create statefulset/alertmanager-kps-alertmanager --timeout="$TIMEOUT"
kubectl -n "$NS" rollout status statefulset/prometheus-kps-prometheus --timeout="$TIMEOUT"
kubectl -n "$NS" rollout status statefulset/alertmanager-kps-alertmanager --timeout="$TIMEOUT"

say "Installing Tempo (single-binary)"
helm upgrade --install tempo grafana/tempo \
  --namespace "$NS" \
  -f k8s/observability/tracing/tempo.values.yaml
kubectl -n "$NS" rollout status statefulset/tempo --timeout="$TIMEOUT"

say "Installing OpenTelemetry Collector (deployment mode)"
helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --namespace "$NS" \
  -f k8s/observability/tracing/otel-collector.values.yaml
kubectl -n "$NS" rollout status deploy/otel-collector --timeout="$TIMEOUT"

# ─── Logstash credentials (file-realm) ─────────────────────────────────────
# Generates the bcrypt+plaintext Secrets for the Logstash file-realm user.
# Guarded so re-runs don't rotate the password under a running Logstash.
say "Applying ES custom-roles Secret"
kubectl apply -f k8s/observability/elastic/custom-roles-secret.yaml

if kubectl -n "$NS" get secret logstash-writer-filerealm >/dev/null 2>&1 \
   && kubectl -n "$NS" get secret logstash-writer-credentials >/dev/null 2>&1; then
  say "Logstash file-realm + credentials Secrets already exist — skipping"
else
  say "Generating Logstash file-realm user (bcrypt via httpd:alpine pod)"
  PW=$(openssl rand -base64 24 | tr -d '=+/' | head -c 24)
  HASH_LINE=$(kubectl -n "$NS" run "bcrypt-gen-$$" \
    --rm -i --restart=Never --quiet \
    --image=httpd:2.4-alpine \
    --command -- htpasswd -nbB logstash_writer "$PW" \
    | grep -E '^logstash_writer:' | tr -d '\r\n')
  if [ -z "$HASH_LINE" ]; then
    echo "ERROR: bcrypt generation failed" >&2
    exit 1
  fi
  kubectl -n "$NS" create secret generic logstash-writer-filerealm \
    --from-literal=users="$HASH_LINE" \
    --from-literal=users_roles="food_delivery_logs_writer:logstash_writer"
  kubectl -n "$NS" create secret generic logstash-writer-credentials \
    --from-literal=LOGSTASH_USER=logstash_writer \
    --from-literal=LOGSTASH_PASSWORD="$PW"
  unset PW HASH_LINE
fi

# ─── Elastic CRDs (need ECK operator) ──────────────────────────────────────
say "Applying Elastic CRDs (Elasticsearch, Kibana, Logstash, Filebeat)"
kubectl apply -n "$NS" -f k8s/observability/elastic/elasticsearch.yaml
kubectl apply -n "$NS" -f k8s/observability/elastic/kibana.yaml
kubectl apply -n "$NS" -f k8s/observability/elastic/logstash.yaml
kubectl apply -f k8s/observability/elastic/filebeat.yaml

say "Waiting for Elasticsearch to be Ready (~3 min)"
kubectl -n "$NS" wait elasticsearch/elasticsearch \
  --for=jsonpath='{.status.phase}'=Ready --timeout="$TIMEOUT"

say "Bootstrapping ILM policy + index template"
kubectl apply -f k8s/observability/elastic/ilm-bootstrap.yaml
kubectl -n "$NS" wait --for=condition=complete job/es-ilm-bootstrap --timeout=5m

# ─── Datasource + ingress + ServiceMonitors + dashboards ───────────────────
say "Applying Tempo datasource ConfigMap"
kubectl apply -f k8s/observability/tracing/grafana-datasource-tempo.yaml

say "Applying observability Ingresses (grafana / kibana / prometheus)"
kubectl apply -f k8s/observability/ingress/observability-ingress.yaml

say "Applying ServiceMonitors"
kubectl apply -f k8s/observability/prometheus/service-monitors/

say "Applying dashboard ConfigMaps"
kubectl apply -f k8s/observability/prometheus/dashboards/

# ─── Done ─────────────────────────────────────────────────────────────────────
cat <<EOF

✅ Observability stack bootstrapped.

Next steps:
  - Add to /etc/hosts:
      \$(minikube ip)  grafana.observability.local kibana.observability.local prometheus.observability.local
  - Browse:
      http://grafana.observability.local      (admin / admin)
      http://kibana.observability.local
      http://prometheus.observability.local
  - Apply your app overlay if not already running:
      kubectl apply -k k8s/overlays/dev
EOF
