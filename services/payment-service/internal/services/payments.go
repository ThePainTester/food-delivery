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
	AmountMinor int64
	Method      string
	CardNumber  string // demo only — used by the simulated gateway
}

// ErrPaymentDeclined is returned when the simulated gateway rejects the
// charge. The handler maps this to HTTP 402 and the consumer publishes
// payment.failed.
var ErrPaymentDeclined = errors.New("payment declined")

type PaymentsService struct {
	repo          *repositories.PaymentsRepo
	rabbit        *events.Rabbit
	defaultMethod string
}

func New(repo *repositories.PaymentsRepo, rabbit *events.Rabbit, defaultMethod string) *PaymentsService {
	return &PaymentsService{repo: repo, rabbit: rabbit, defaultMethod: defaultMethod}
}

// MethodCash signals that the customer chose cash on delivery. The gateway
// is bypassed and the payment record stays in PENDING until the driver
// collects on delivery and calls CollectCash.
const MethodCash = "cash"

// CreateForOrder records a payment for the given order. For card payments
// it synchronously charges via the (simulated) gateway and publishes either
// payment.completed or payment.failed. For cash it skips the gateway and
// leaves the payment PENDING — the driver settles on delivery.
//
// Idempotent at the order_id boundary — a retry against an already-paid
// order returns the existing payment record.
func (s *PaymentsService) CreateForOrder(ctx context.Context, in CreateInput) (*models.Payment, error) {
	method := in.Method
	if method == "" {
		method = s.defaultMethod
	}

	// Idempotency: if a payment already exists for this order, return it
	// without re-billing the gateway or creating a duplicate cash record.
	if existing, err := s.repo.GetByOrderID(ctx, in.OrderID); err == nil {
		return existing, nil
	} else if !errors.Is(err, repositories.ErrNotFound) {
		return nil, err
	}

	if method == MethodCash {
		p, err := s.repo.Create(ctx, &models.Payment{
			OrderID:     in.OrderID,
			CustomerID:  in.CustomerID,
			AmountMinor: in.AmountMinor,
			Status:      models.StatusPending,
			Method:      method,
		})
		if err != nil {
			return nil, err
		}
		if perr := s.rabbit.Publish(ctx, "payment.pending", map[string]any{
			"payment_id": p.ID,
			"order_id":   p.OrderID,
			"amount":     money.ToFloat(p.AmountMinor),
			"method":     p.Method,
		}); perr != nil {
			slog.Error("publish payment.pending failed", "payment_id", p.ID, "err", perr)
		}
		return p, nil
	}

	res, err := chargeViaGateway(ctx, in.CardNumber, in.AmountMinor)
	if err != nil {
		return nil, err
	}

	status := models.StatusCompleted
	if !res.ok {
		status = models.StatusFailed
	}
	p, err := s.repo.Create(ctx, &models.Payment{
		OrderID:     in.OrderID,
		CustomerID:  in.CustomerID,
		AmountMinor: in.AmountMinor,
		Status:      status,
		Method:      method,
	})
	if errors.Is(err, repositories.ErrAlreadyExists) {
		existing, gerr := s.repo.GetByOrderID(ctx, in.OrderID)
		if gerr != nil {
			return nil, gerr
		}
		return existing, nil
	}
	if err != nil {
		return nil, err
	}

	if !res.ok {
		if perr := s.rabbit.Publish(ctx, "payment.failed", map[string]any{
			"payment_id": p.ID,
			"order_id":   p.OrderID,
			"reason":     res.reason,
		}); perr != nil {
			slog.Error("publish payment.failed failed", "payment_id", p.ID, "err", perr)
		}
		return p, ErrPaymentDeclined
	}

	if perr := s.rabbit.Publish(ctx, "payment.completed", map[string]any{
		"payment_id":   p.ID,
		"order_id":     p.OrderID,
		"amount":       money.ToFloat(p.AmountMinor),
		"method":       p.Method,
		"completed_at": time.Now().UTC().Format(time.RFC3339Nano),
	}); perr != nil {
		slog.Error("publish payment.completed failed", "payment_id", p.ID, "err", perr)
	}
	return p, nil
}

// CollectCash marks the cash payment for the given order as COMPLETED and
// publishes payment.completed so order-service can flip the order's paid
// flag. Returns the existing payment unchanged if it was already completed.
func (s *PaymentsService) CollectCash(ctx context.Context, orderID string) (*models.Payment, error) {
	p, err := s.repo.MarkCompletedByOrderID(ctx, orderID)
	if errors.Is(err, repositories.ErrAlreadyExists) {
		// Already collected — no-op, return the row.
		return p, nil
	}
	if err != nil {
		return nil, err
	}
	if p.Method != MethodCash {
		// Only cash payments are eligible for manual collection. Card payments
		// flow through the gateway path. Treat as already-settled.
		return p, nil
	}
	if perr := s.rabbit.Publish(ctx, "payment.completed", map[string]any{
		"payment_id":   p.ID,
		"order_id":     p.OrderID,
		"amount":       money.ToFloat(p.AmountMinor),
		"method":       p.Method,
		"completed_at": time.Now().UTC().Format(time.RFC3339Nano),
	}); perr != nil {
		slog.Error("publish payment.completed failed (cash)", "payment_id", p.ID, "err", perr)
	}
	return p, nil
}

// GetByOrderID returns the payment for an order or ErrNotFound.
func (s *PaymentsService) GetByOrderID(ctx context.Context, orderID string) (*models.Payment, error) {
	return s.repo.GetByOrderID(ctx, orderID)
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
