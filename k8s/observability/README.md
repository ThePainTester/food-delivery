# Observability

Three-pillar observability for the food-delivery platform, deployed
into a single shared `observability` namespace and watching every
`food-delivery-*` env namespace simultaneously.

| Pillar  | Stack                                                              | UI                                  |
|---------|--------------------------------------------------------------------|-------------------------------------|
| Metrics | kube-prometheus-stack (Prometheus + Alertmanager + Grafana)        | grafana.observability.local         |
| Logs    | ECK ELK (Elasticsearch + Logstash + Kibana + Filebeat DaemonSet)   | kibana.observability.local          |
| Traces  | grafana/tempo + open-telemetry/opentelemetry-collector             | (in Grafana, datasource = "Tempo")  |

Prometheus is also browsable at `prometheus.observability.local`.

## One-time install

```bash
# Repos
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add elastic               https://helm.elastic.co
helm repo add grafana               https://grafana.github.io/helm-charts
helm repo add open-telemetry        https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

kubectl create namespace observability

# 1. ECK operator (cluster-wide)
helm upgrade --install eck-operator elastic/eck-operator \
  --namespace elastic-system --create-namespace \
  -f k8s/observability/elastic/eck-operator.values.yaml

# 2. kube-prometheus-stack — Prometheus + Alertmanager + Grafana + kube-state-metrics + node-exporter
helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  --namespace observability \
  -f k8s/observability/prometheus/kube-prometheus-stack.values.yaml

# 3. Tempo (single-binary)
helm upgrade --install tempo grafana/tempo \
  --namespace observability \
  -f k8s/observability/tracing/tempo.values.yaml

# 4. OTel Collector (deployment mode — apps push to its Service)
helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --namespace observability \
  -f k8s/observability/tracing/otel-collector.values.yaml

# 5. ECK CRDs (Elasticsearch / Kibana / Logstash / Filebeat)
kubectl apply -n observability -f k8s/observability/elastic/elasticsearch.yaml
kubectl apply -n observability -f k8s/observability/elastic/kibana.yaml
kubectl apply -n observability -f k8s/observability/elastic/logstash.yaml
kubectl apply              -f k8s/observability/elastic/filebeat.yaml   # DaemonSet, has its own RBAC

# 5b. ILM policy + index template (idempotent; the Job's init container
# waits for ES to be ready, so this can be applied straight after the
# CRDs without manual sequencing).
kubectl apply -f k8s/observability/elastic/ilm-bootstrap.yaml

# 6. Grafana Tempo datasource + ingress + ServiceMonitors + dashboards
kubectl apply -f k8s/observability/tracing/grafana-datasource-tempo.yaml
kubectl apply -f k8s/observability/ingress/observability-ingress.yaml
kubectl apply -f k8s/observability/prometheus/service-monitors/   # populated in Phase 2/4/5
kubectl apply -f k8s/observability/prometheus/dashboards/         # populated in Phase 5
```

## /etc/hosts

```
$(minikube ip)  grafana.observability.local
$(minikube ip)  kibana.observability.local
$(minikube ip)  prometheus.observability.local
```

## Default credentials

Grafana: `admin / admin` (set via Helm values; rotate or read from a
sealed Secret in real environments). Elasticsearch security is
**disabled** in this Minikube deployment so Logstash/Kibana/Filebeat can
connect over plain HTTP — do not reuse this configuration outside local
development.

## Cross-namespace observation

Prometheus is configured with empty namespace/object selectors, which
means *any* `ServiceMonitor` or `PodMonitor` in the cluster gets picked
up. App workloads in `food-delivery-{dev,staging,prod}` and the ingress
controller in `ingress-nginx` are scraped from this single Prometheus.
Filebeat runs as a DaemonSet, attaches `kubernetes.namespace`, and
Logstash promotes `food-delivery-(dev|staging|prod)` → `env=dev|...`
so every log line carries its environment.

## Layout

```
k8s/observability/
├── prometheus/
│   ├── kube-prometheus-stack.values.yaml
│   ├── service-monitors/   # filled in Phase 2 (infra) and Phase 4/5 (frontend, ingress)
│   ├── pod-monitors/
│   └── dashboards/         # filled in Phase 5 (Grafana JSON as ConfigMaps)
├── elastic/
│   ├── eck-operator.values.yaml
│   ├── elasticsearch.yaml
│   ├── kibana.yaml
│   ├── logstash.yaml
│   ├── filebeat.yaml
│   └── ilm-bootstrap.yaml   # 7-day ILM policy + index template (Job)
├── tracing/
│   ├── tempo.values.yaml
│   ├── otel-collector.values.yaml
│   └── grafana-datasource-tempo.yaml
└── ingress/
    └── observability-ingress.yaml
```
