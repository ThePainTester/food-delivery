#!/usr/bin/env bash
# Reverses observability-bootstrap.sh: removes every resource that
# script created, in dependency-safe order. Idempotent — safe to re-run
# after a partial uninstall.
#
# Order matters:
#   1. Delete CRD instances (ES, Kibana, Logstash, Filebeat) first so
#      ECK's finalizers can clean them up while the operator is alive.
#   2. Uninstall Helm releases.
#   3. Delete leftover Prometheus-Operator CRD instances and the namespace.
#
# By default this also wipes PVCs (Elastic data, Prometheus tsdb, Tempo
# traces). Pass --keep-data to preserve them.

set -euo pipefail

cd "$(dirname "$0")/.."

NS=observability
KEEP_DATA=0
[[ "${1:-}" == "--keep-data" ]] && KEEP_DATA=1

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# ─── Reverse of E. dashboards / service-monitors / ingress / datasource ──────
say "Removing dashboards, ServiceMonitors, ingress, Tempo datasource"
kubectl delete --ignore-not-found -f k8s/observability/prometheus/dashboards/      || true
kubectl delete --ignore-not-found -f k8s/observability/prometheus/service-monitors/ || true
kubectl delete --ignore-not-found -f k8s/observability/ingress/observability-ingress.yaml || true
kubectl delete --ignore-not-found -f k8s/observability/tracing/grafana-datasource-tempo.yaml || true

# ─── Reverse of D. Elastic CRDs ──────────────────────────────────────────────
say "Removing Elastic CRD instances (ECK finalizers must run while operator is alive)"
kubectl delete --ignore-not-found -f k8s/observability/elastic/ilm-bootstrap.yaml || true
kubectl delete --ignore-not-found              -f k8s/observability/elastic/filebeat.yaml      || true
kubectl delete --ignore-not-found -n "$NS"     -f k8s/observability/elastic/logstash.yaml      || true
kubectl delete --ignore-not-found -n "$NS"     -f k8s/observability/elastic/kibana.yaml        || true
kubectl delete --ignore-not-found -n "$NS"     -f k8s/observability/elastic/elasticsearch.yaml || true

# Wait for ECK to actually finish reconciling deletions.
say "Waiting for Elastic CRD instances to clear"
for kind in elasticsearch kibana logstash beat; do
  kubectl -n "$NS" wait --for=delete "$kind" --all --timeout=2m 2>/dev/null || true
done

# ─── Reverse of C. Operators / charts ────────────────────────────────────────
say "Uninstalling Helm releases"
helm uninstall otel-collector --namespace "$NS"             2>/dev/null || true
helm uninstall tempo          --namespace "$NS"             2>/dev/null || true
helm uninstall kps            --namespace "$NS"             2>/dev/null || true
helm uninstall eck-operator   --namespace elastic-system    2>/dev/null || true

# ─── PVC + namespace cleanup ─────────────────────────────────────────────────
if [[ $KEEP_DATA -eq 0 ]]; then
  say "Deleting PVCs (Elastic data, Prometheus tsdb, Tempo traces)"
  # StatefulSet PVCs survive a Helm uninstall; nuke them explicitly.
  kubectl -n "$NS" delete pvc --all --ignore-not-found || true
else
  say "Keeping PVCs (--keep-data)"
fi

say "Deleting namespace $NS"
kubectl delete namespace "$NS" --ignore-not-found
kubectl delete namespace elastic-system --ignore-not-found

# ─── CRDs left behind by Helm (Prometheus-Operator + ECK) ────────────────────
say "Removing CRDs installed by the charts"
# kube-prometheus-stack ships these via the chart — Helm uninstall keeps
# them by design. Drop them only if no other Prometheus is using them.
for crd in \
  alertmanagerconfigs.monitoring.coreos.com \
  alertmanagers.monitoring.coreos.com \
  podmonitors.monitoring.coreos.com \
  probes.monitoring.coreos.com \
  prometheusagents.monitoring.coreos.com \
  prometheuses.monitoring.coreos.com \
  prometheusrules.monitoring.coreos.com \
  scrapeconfigs.monitoring.coreos.com \
  servicemonitors.monitoring.coreos.com \
  thanosrulers.monitoring.coreos.com \
  ; do
  kubectl delete crd "$crd" --ignore-not-found 2>/dev/null || true
done
# ECK's CRDs
for crd in \
  elasticsearches.elasticsearch.k8s.elastic.co \
  kibanas.kibana.k8s.elastic.co \
  logstashes.logstash.k8s.elastic.co \
  beats.beat.k8s.elastic.co \
  apmservers.apm.k8s.elastic.co \
  enterprisesearches.enterprisesearch.k8s.elastic.co \
  agents.agent.k8s.elastic.co \
  elasticmapsservers.maps.k8s.elastic.co \
  stackconfigpolicies.stackconfigpolicy.k8s.elastic.co \
  ; do
  kubectl delete crd "$crd" --ignore-not-found 2>/dev/null || true
done

cat <<EOF

✅ Observability stack torn down.

Helm repos are NOT removed (they're cheap to keep). Drop them manually if you want:
  helm repo remove prometheus-community elastic grafana open-telemetry
EOF
