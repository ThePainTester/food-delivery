package services

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/food-delivery/payment-service/internal/events"
	"github.com/food-delivery/payment-service/internal/models"
	"github.com/food-delivery/payment-service/internal/money"
	"github.com/food-delivery/payment-service/internal/repositories"
)

type ActorKind string

const (
	ActorUser   ActorKind = "user"
	ActorSystem ActorKind = "system"
)

type Actor struct {
	Kind   ActorKind
	UserID string // populated when Kind == ActorUser
	Role   string
}

type CreateInput struct {
	OrderID     string
	CustomerID  *string // optional; populated from event-driven path
	AmountCents int64
	Method      string
}

type PaymentsService struct {
	repo          *repositories.PaymentsRepo
	rabbit        *events.Rabbit
	defaultMethod string
}

func New(repo *repositories.PaymentsRepo, rabbit *events.Rabbit, defaultMethod string) *PaymentsService {
	return &PaymentsService{repo: repo, rabbit: rabbit, defaultMethod: defaultMethod}
}

// CreateForOrder creates a payment in COMPLETED state (mock always succeeds)
// and publishes payment.completed. Idempotent at the order_id boundary.
func (s *PaymentsService) CreateForOrder(ctx context.Context, in CreateInput) (*models.Payment, error) {
	method := in.Method
	if method == "" {
		method = s.defaultMethod
	}
	p, err := s.repo.Create(ctx, &models.Payment{
		OrderID:     in.OrderID,
		CustomerID:  in.CustomerID,
		AmountCents: in.AmountCents,
		Status:      models.StatusCompleted,
		Method:      method,
	})
	if errors.Is(err, repositories.ErrAlreadyExists) {
		// Already paid (event redelivery before idempotency table caught up).
		existing, gerr := s.repo.GetByOrderID(ctx, in.OrderID)
		if gerr != nil {
			return nil, gerr
		}
		return existing, nil
	}
	if err != nil {
		return nil, err
	}

	if perr := s.rabbit.Publish(ctx, "payment.completed", map[string]any{
		"payment_id":   p.ID,
		"order_id":     p.OrderID,
		"amount":       money.ToFloat(p.AmountCents),
		"method":       p.Method,
		"completed_at": time.Now().UTC().Format(time.RFC3339Nano),
	}); perr != nil {
		// Publish failed — log, but don't roll back the DB write. The
		// idempotency table + ON CONFLICT means a retry won't double-charge.
		slog.Error("publish payment.completed failed", "payment_id", p.ID, "err", perr)
	}
	return p, nil
}

func (s *PaymentsService) GetForActor(ctx context.Context, id string, actor Actor) (*models.Payment, error) {
	p, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	// If we know the customer, only that customer (or system) can read it.
	if actor.Kind == ActorUser && p.CustomerID != nil && *p.CustomerID != actor.UserID {
		return nil, ErrForbidden
	}
	return p, nil
}

// RecordRefund is a no-op for the mock; it just logs and returns. Kept here
// so the consumer wires through the service layer like every other event.
func (s *PaymentsService) RecordRefund(ctx context.Context, orderID, reason string) error {
	slog.Info("refund (no-op)", "order_id", orderID, "reason", reason)
	return nil
}

var ErrForbidden = errors.New("forbidden")
