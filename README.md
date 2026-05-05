# food-delivery

Polyglot microservices food-delivery platform: User (Go), Restaurant (Python),
Order (Node/TS), Payment (Go mock), a static SPA frontend, and a stock Traefik
gateway that fronts everything.

## Running

One-time setup (per env):

```bash
cp compose/.env.example compose/.env.dev      # then edit COMPOSE_PROJECT_NAME=food-delivery-dev
cp compose/.env.example compose/.env.staging  # COMPOSE_PROJECT_NAME=food-delivery-staging
cp compose/.env.example compose/.env.prod     # COMPOSE_PROJECT_NAME=food-delivery-prod
compose/scripts/gen-keys.sh                   # writes compose/jwt/{jwt.key,jwt.pub}
```

Bring up a single env (dev shown):

```bash
docker compose \
  -f compose/docker-compose.yml \
  -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev \
  up --build
```

Swap the overlay file and the env file for staging/prod. Staging and prod
expect images already pushed to `${REGISTRY}` at the right tag — they don't
build.

## Running all three envs side-by-side

Each env's `COMPOSE_PROJECT_NAME` (set in its `.env.<env>` file) prefixes its
own networks, volumes, and containers, so the three stacks stay isolated.
Published ports also don't collide: dev exposes the gateway on `3000` plus
direct-debug ports on the data stores and service containers; staging exposes
only the gateway on `8080`; prod exposes only `80`/`443`.

Bring all three up in three terminals (or detached):

```bash
# dev
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev up -d --build

# staging
docker compose -f compose/docker-compose.yml -f compose/docker-compose.staging.yml \
  --env-file compose/.env.staging up -d

# prod
docker compose -f compose/docker-compose.yml -f compose/docker-compose.prod.yml \
  --env-file compose/.env.prod up -d
```

Inspect one stack at a time by passing the same `--env-file` (or `-p
<project-name>` together with `COMPOSE_PROJECT_NAME=<project-name>` in the
shell):

```bash
docker compose --env-file compose/.env.staging ps
docker compose --env-file compose/.env.staging logs -f gateway
```

Tear down a single env without touching the others:

```bash
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev down -v
```

> Use `--env-file` not `-p` for stack selection. `-p` sets the project name
> for prefixing but does **not** populate `${COMPOSE_PROJECT_NAME}` for
> variable substitution in the compose file, which Traefik relies on. The env
> file feeds both paths from one source.

## Accessing the SPA

| Env | URL | Notes |
|---|---|---|
| Dev     | <http://localhost:3000>     | Traefik dashboard: <http://localhost:8090> |
| Staging | <http://\<host\>:8080>      | gateway only |
| Prod    | <http://\<host\>> / <https://\<host\>> | 80 + 443 published |

In every environment the browser talks only to the **gateway** container
(stock Traefik); the gateway forwards `/api/*` to the backend services and
`/` to the static frontend container, all over the internal compose
network. Routing rules live as `traefik.*` labels on each service in
`compose/docker-compose.yml`. Backend service ports are also published in
dev (8081–8084) for direct testing, but the browser doesn't use them.

See [`compose/README.md`](compose/README.md) for the full port map and
[`services/frontend/README.md`](services/frontend/README.md) for SPA
routes.

## Kubernetes (Minikube)

The Compose stack is the local-first iteration loop. The Kustomize tree
under `k8s/` deploys the same images to a Kubernetes cluster, with three
overlays (`dev` / `test` / `prod`) that each live in their own namespace and
their own ingress host so all three can run side-by-side on one Minikube.

### Prerequisites

```bash
minikube start
minikube addons enable ingress       # NGINX Ingress controller
```

### Build images into Minikube's Docker daemon

The dev/staging overlays use `imagePullPolicy: IfNotPresent` and reference
local image tags (`:dev`, `:staging`). Build them inside Minikube's daemon so
the cluster can find them without a registry:

```bash
eval $(minikube docker-env)

# Same Compose build, tagged for k8s/dev:
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev build

# Re-tag with the dev/staging tags the overlays expect:
for svc in user-service restaurant-service order-service payment-service frontend; do
  docker tag food-delivery/${svc}:latest food-delivery/${svc}:dev
  docker tag food-delivery/${svc}:latest food-delivery/${svc}:staging
done
```

(For prod, push to a real registry and pin the image with
`kustomize edit set image food-delivery/user-service=registry.example.com/user-service:v1.4.2`
inside `k8s/overlays/prod/` before applying.)

### Replace the JWT keypair stub

`k8s/base/secrets/jwt-keypair.yaml` ships with placeholder strings so
`kubectl kustomize` doesn't error out before you've configured anything.
Generate real RS256 keys and inline them, or apply a separately-managed
Secret of the same name:

```bash
openssl genpkey -algorithm RSA -out /tmp/jwt.key -pkeyopt rsa_keygen_bits:2048
openssl rsa -in /tmp/jwt.key -pubout -out /tmp/jwt.pub
# then paste the file contents into k8s/base/secrets/jwt-keypair.yaml
```

### Private registry credentials (staging / prod)

The `staging` and `prod` overlays patch every Deployment with
`imagePullSecrets: [{name: ghcr-credentials}]` so kubelet can pull from your
private registry. The Secret itself is *not* in git — create it once per
namespace before the first apply:

```bash
# GitHub Container Registry example — username is your GitHub login,
# password is a Personal Access Token with `read:packages` scope.
for ns in food-delivery-staging food-delivery-prod; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret docker-registry ghcr-credentials \
    --docker-server=ghcr.io \
    --docker-username=YOUR_GITHUB_USERNAME \
    --docker-password=YOUR_GITHUB_PAT \
    --namespace="$ns"
done
```

For other registries, change `--docker-server` accordingly
(`docker.io` for Docker Hub, `<account>.dkr.ecr.<region>.amazonaws.com` for
ECR, etc.). The `dev` overlay doesn't need this — it builds into Minikube's
local Docker daemon and pulls nothing.

### Deploy an overlay

```bash
kubectl apply -k k8s/overlays/dev
kubectl apply -k k8s/overlays/staging
kubectl apply -k k8s/overlays/prod
```

(`kustomize build … | kubectl apply -f -` works the same way.)

Schema migrations run automatically: each app Deployment has an
`initContainers:` block that runs [`golang-migrate`](https://github.com/golang-migrate/migrate)
against the right Postgres before the app container starts. The `migrate`
binary and the `migrations/*.up.sql` files are baked into each service
image at build time, so no Kustomize ConfigMap or cross-directory file
access is needed. Re-applying is safe — `migrate` tracks applied versions
in a `schema_migrations` table on the target DB.

### `/etc/hosts` entries

Each overlay serves on its own host, mapped to the Minikube IP
(`minikube ip`):

```
$(minikube ip)  dev.food-delivery.local
$(minikube ip)  staging.food-delivery.local
$(minikube ip)  food-delivery.local
```

Then browse to <http://dev.food-delivery.local>, <http://staging.food-delivery.local>,
or <http://food-delivery.local>.

### Inspect a single env

```bash
kubectl get all -n food-delivery-dev
kubectl logs -n food-delivery-dev deploy/order-service -f
kubectl exec -n food-delivery-dev -it statefulset/orders-db -- psql -U orders -d orders
```

### Tear down a single env

```bash
kubectl delete -k k8s/overlays/dev
# Or namespace-delete (slower but tidier):
kubectl delete namespace food-delivery-dev
```

> Deleting the namespace also removes the PVCs, so all persistent state
> (restaurant docs, orders, payments, RabbitMQ queue files) is wiped.

## Observability

Three-pillar observability — metrics, logs, traces — deployed once into
a single shared `observability` namespace, watching all three env
namespaces (`food-delivery-{dev,staging,prod}`) at the same time. Full
manifests live under [`k8s/observability/`](k8s/observability) with its
own [README](k8s/observability/README.md).

| Pillar  | Stack                                                              | UI                                  |
|---------|--------------------------------------------------------------------|-------------------------------------|
| Metrics | kube-prometheus-stack (Prometheus + Alertmanager + Grafana)        | <http://grafana.observability.local>      |
| Logs    | ECK ELK (Elasticsearch + Logstash + Kibana + Filebeat DaemonSet)   | <http://kibana.observability.local>       |
| Traces  | grafana/tempo + open-telemetry/opentelemetry-collector             | (in Grafana, datasource `Tempo`)    |

Prometheus is also browsable at <http://prometheus.observability.local>.

### One-time install

```bash
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

# 2. kube-prometheus-stack
helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  --namespace observability \
  -f k8s/observability/prometheus/kube-prometheus-stack.values.yaml

# 3. Tempo
helm upgrade --install tempo grafana/tempo \
  --namespace observability \
  -f k8s/observability/tracing/tempo.values.yaml

# 4. OTel Collector (deployment mode — apps push OTLP gRPC to its Service)
helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --namespace observability \
  -f k8s/observability/tracing/otel-collector.values.yaml

# 5. Elastic CRDs
kubectl apply -n observability -f k8s/observability/elastic/elasticsearch.yaml
kubectl apply -n observability -f k8s/observability/elastic/kibana.yaml
kubectl apply -n observability -f k8s/observability/elastic/logstash.yaml
kubectl apply              -f k8s/observability/elastic/filebeat.yaml
kubectl apply -f k8s/observability/elastic/ilm-bootstrap.yaml   # 7-day ILM policy + index template

# 6. Cluster-wide pieces (Tempo datasource, ingress, ServiceMonitors, dashboards)
kubectl apply -f k8s/observability/tracing/grafana-datasource-tempo.yaml
kubectl apply -f k8s/observability/ingress/observability-ingress.yaml
kubectl apply -f k8s/observability/prometheus/service-monitors/
kubectl apply -f k8s/observability/prometheus/dashboards/
```

### `/etc/hosts` entries

```
$(minikube ip)  grafana.observability.local
$(minikube ip)  kibana.observability.local
$(minikube ip)  prometheus.observability.local
```

### Default credentials

Grafana ships with `admin / admin` (configured via Helm values; rotate
or pull from a sealed Secret in real environments). Elasticsearch
security is **disabled** in this Minikube deployment so Logstash,
Kibana, and Filebeat can connect over plain HTTP — fine for local
development, never for prod-grade use.

### Dashboards

Pre-provisioned via ConfigMaps with the `grafana_dashboard: "1"` label;
Grafana's sidecar discovers them automatically and groups them under a
"Food Delivery" folder.

| Dashboard | What it shows |
|---|---|
| Service RED            | Per-service request rate, 5xx rate, p95 / p50 latency. `env` + `service` template variables. |
| Order Pipeline         | Orders placed, payment success rate, RabbitMQ queue depth + unacked, p95 latency by service, errors per service. |
| Ingress (NGINX Controller) | Per-host request rate, status-class breakdown, p95 upstream latency, 5xx by host. |
| Frontend NGINX         | Active connections, connection states, requests/sec, accepted vs handled. |

Plus the kube-prometheus-stack defaults (cluster, nodes, pods,
kube-state-metrics, node-exporter — all bundled with the chart).
