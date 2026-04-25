package main

import (
	"context"
	"log"
	"net/http"

	"github.com/food-delivery/payment-service/internal/auth"
	"github.com/food-delivery/payment-service/internal/config"
	"github.com/food-delivery/payment-service/internal/consumers"
	"github.com/food-delivery/payment-service/internal/db"
	"github.com/food-delivery/payment-service/internal/events"
	"github.com/food-delivery/payment-service/internal/handlers"
	"github.com/food-delivery/payment-service/internal/middleware"
	"github.com/food-delivery/payment-service/internal/repositories"
	"github.com/food-delivery/payment-service/internal/services"
	"github.com/gin-gonic/gin"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx := context.Background()
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

	r := gin.Default()
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	authed := r.Group("/payments", middleware.RequireAuth(verifier))
	{
		authed.POST("", h.Create)
		authed.GET("/:id", h.Get)
	}

	log.Printf("payment-service listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("server: %v", err)
	}
}
