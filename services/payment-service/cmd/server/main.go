package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"

	"github.com/food-delivery/payment-service/internal/auth"
	"github.com/food-delivery/payment-service/internal/config"
	"github.com/food-delivery/payment-service/internal/consumers"
	"github.com/food-delivery/payment-service/internal/db"
	"github.com/food-delivery/payment-service/internal/events"
	"github.com/food-delivery/payment-service/internal/handlers"
	"github.com/food-delivery/payment-service/internal/middleware"
	"github.com/food-delivery/payment-service/internal/observability"
	"github.com/food-delivery/payment-service/internal/repositories"
	"github.com/food-delivery/payment-service/internal/services"
	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	slog.SetDefault(observability.JSONLogger("payment-service"))

	ctx := context.Background()
	shutdown, err := observability.InitTracer(ctx, "payment-service")
	if err != nil {
		slog.Error("otel init failed", "err", err)
	} else {
		defer func() { _ = shutdown(context.Background()) }()
	}

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	rabbit, err := events.New(cfg.RabbitURL, "payment-service", "payment")
	if err != nil {
		log.Fatalf("rabbit: %v", err)
	}
	defer rabbit.Close()

	verifier, err := auth.NewVerifier(cfg.JWTPublicKey, cfg.JWTIssuer)
	if err != nil {
		log.Fatalf("jwt: %v", err)
	}

	repo := repositories.New(pool)
	svc := services.New(repo, rabbit, cfg.DefaultPaymentMethod)

	if err := consumers.Start(rabbit, repo, svc); err != nil {
		log.Fatalf("consumers: %v", err)
	}

	h := handlers.New(svc)

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(otelgin.Middleware("payment-service"))
	r.Use(observability.PromMiddleware())

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/metrics", observability.MetricsHandler())

	authed := r.Group("/payments", middleware.RequireAuth(verifier))
	{
		authed.POST("", h.Create)
		authed.GET("/by-order/:orderId", h.GetByOrder)
		authed.POST("/by-order/:orderId/collect", h.CollectCash)
		authed.GET("/:id", h.Get)
	}

	slog.Info("payment-service listening", "port", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("server: %v", err)
	}
}
