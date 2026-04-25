package handlers

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/food-delivery/payment-service/internal/middleware"
	"github.com/food-delivery/payment-service/internal/models"
	"github.com/food-delivery/payment-service/internal/money"
	"github.com/food-delivery/payment-service/internal/repositories"
	"github.com/food-delivery/payment-service/internal/services"
	"github.com/gin-gonic/gin"
)

type handler struct {
	svc *services.PaymentsService
}

func New(svc *services.PaymentsService) *handler {
	return &handler{svc: svc}
}

func errResp(c *gin.Context, status int, code, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": code, "message": msg})
}

func serverErr(c *gin.Context, op string, err error) {
	slog.Error("handler error", "op", op, "path", c.FullPath(), "err", err)
	c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
		"error":   "internal_error",
		"message": "internal server error",
	})
}

type paymentDTO struct {
	ID         string  `json:"id"`
	OrderID    string  `json:"order_id"`
	Amount     string  `json:"amount"`
	Status     string  `json:"status"`
	Method     string  `json:"method"`
	CreatedAt  string  `json:"created_at"`
}

func toDTO(p *models.Payment) paymentDTO {
	return paymentDTO{
		ID:        p.ID,
		OrderID:   p.OrderID,
		Amount:    money.ToString(p.AmountCents),
		Status:    string(p.Status),
		Method:    p.Method,
		CreatedAt: p.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
}

type createReq struct {
	OrderID string  `json:"order_id" binding:"required,uuid"`
	Amount  float64 `json:"amount" binding:"required,gt=0"`
	Method  string  `json:"method"`
}

func (h *handler) Create(c *gin.Context) {
	var req createReq
	if err := c.ShouldBindJSON(&req); err != nil {
		errResp(c, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	p, err := h.svc.CreateForOrder(c, services.CreateInput{
		OrderID:     req.OrderID,
		AmountCents: money.FromFloat(req.Amount),
		Method:      req.Method,
	})
	if err != nil {
		serverErr(c, "create_payment", err)
		return
	}
	c.JSON(http.StatusCreated, toDTO(p))
}

func (h *handler) Get(c *gin.Context) {
	actor := services.Actor{
		Kind:   services.ActorUser,
		UserID: c.GetString(middleware.CtxUserID),
		Role:   c.GetString(middleware.CtxRole),
	}
	p, err := h.svc.GetForActor(c, c.Param("id"), actor)
	if err != nil {
		if errors.Is(err, repositories.ErrNotFound) {
			errResp(c, http.StatusNotFound, "not_found", "payment not found")
			return
		}
		if errors.Is(err, services.ErrForbidden) {
			errResp(c, http.StatusForbidden, "forbidden", "not allowed")
			return
		}
		serverErr(c, "get_payment", err)
		return
	}
	c.JSON(http.StatusOK, toDTO(p))
}
