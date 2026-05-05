package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"

	"github.com/food-delivery/user-service/internal/auth"
	"github.com/food-delivery/user-service/internal/config"
	"github.com/food-delivery/user-service/internal/db"
	"github.com/food-delivery/user-service/internal/handlers"
	"github.com/food-delivery/user-service/internal/middleware"
	"github.com/food-delivery/user-service/internal/observability"
	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	slog.SetDefault(observability.JSONLogger("user-service"))

	ctx := context.Background()
	shutdown, err := observability.InitTracer(ctx, "user-service")
	if err != nil {
		slog.Error("otel init failed", "err", err)
	} else {
		defer func() { _ = shutdown(context.Background()) }()
	}

	store, err := db.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer store.Close()

	signer, err := auth.NewSigner(cfg.JWTPrivateKey, cfg.JWTPublicKey, cfg.JWTIssuer, cfg.JWTTTL)
	if err != nil {
		log.Fatalf("jwt: %v", err)
	}

	h := handlers.New(store, signer)

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(otelgin.Middleware("user-service"))
	r.Use(observability.PromMiddleware())

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/metrics", observability.MetricsHandler())
	r.GET("/.well-known/jwks.pem", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/x-pem-file", cfg.JWTPublicKey)
	})

	authGroup := r.Group("/auth")
	{
		authGroup.POST("/register", h.Register)
		authGroup.POST("/login", h.Login)
	}

	users := r.Group("/users", middleware.RequireAuth(signer))
	{
		users.GET("/me", h.Me)
		users.PATCH("/me", h.PatchMe)
		users.GET("/:id", h.GetUser)
	}

	slog.Info("user-service listening", "port", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("server: %v", err)
	}
}
