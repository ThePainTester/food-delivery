package main

import (
	"context"
	"log"
	"net/http"

	"github.com/food-delivery/user-service/internal/auth"
	"github.com/food-delivery/user-service/internal/config"
	"github.com/food-delivery/user-service/internal/db"
	"github.com/food-delivery/user-service/internal/handlers"
	"github.com/food-delivery/user-service/internal/middleware"
	"github.com/gin-gonic/gin"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx := context.Background()
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

	r := gin.Default()

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
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

	log.Printf("user-service listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("server: %v", err)
	}
}
