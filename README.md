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
