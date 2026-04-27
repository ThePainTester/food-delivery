package repositories

import (
	"context"
	"errors"

	"github.com/food-delivery/payment-service/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound       = errors.New("not found")
	ErrAlreadyExists  = errors.New("payment for order already exists")
)

type PaymentsRepo struct {
	Pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *PaymentsRepo { return &PaymentsRepo{Pool: pool} }

func (r *PaymentsRepo) Create(ctx context.Context, p *models.Payment) (*models.Payment, error) {
	row := r.Pool.QueryRow(ctx, `
		INSERT INTO payments (order_id, customer_id, amount_cents, status, method)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, order_id, customer_id, amount_cents, status, method, created_at
	`, p.OrderID, p.CustomerID, p.AmountCents, p.Status, p.Method)
	out := &models.Payment{}
	if err := row.Scan(&out.ID, &out.OrderID, &out.CustomerID, &out.AmountCents, &out.Status, &out.Method, &out.CreatedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrAlreadyExists
		}
		return nil, err
	}
	return out, nil
}

func (r *PaymentsRepo) GetByID(ctx context.Context, id string) (*models.Payment, error) {
	out := &models.Payment{}
	err := r.Pool.QueryRow(ctx, `
		SELECT id, order_id, customer_id, amount_cents, status, method, created_at
		FROM payments WHERE id = $1
	`, id).Scan(&out.ID, &out.OrderID, &out.CustomerID, &out.AmountCents, &out.Status, &out.Method, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (r *PaymentsRepo) GetByOrderID(ctx context.Context, orderID string) (*models.Payment, error) {
	out := &models.Payment{}
	err := r.Pool.QueryRow(ctx, `
		SELECT id, order_id, customer_id, amount_cents, status, method, created_at
		FROM payments WHERE order_id = $1
	`, orderID).Scan(&out.ID, &out.OrderID, &out.CustomerID, &out.AmountCents, &out.Status, &out.Method, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

// MarkCompletedByOrderID flips a PENDING payment for the given order to
// COMPLETED. Returns the updated payment, ErrNotFound if there isn't one,
// or ErrAlreadyExists if the payment isn't in PENDING (used for cash
// collection — once collected, idempotent retries should not double-publish).
func (r *PaymentsRepo) MarkCompletedByOrderID(ctx context.Context, orderID string) (*models.Payment, error) {
	out := &models.Payment{}
	err := r.Pool.QueryRow(ctx, `
		UPDATE payments SET status = 'COMPLETED'
		WHERE order_id = $1 AND status = 'PENDING'
		RETURNING id, order_id, customer_id, amount_cents, status, method, created_at
	`, orderID).Scan(&out.ID, &out.OrderID, &out.CustomerID, &out.AmountCents, &out.Status, &out.Method, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Nothing in PENDING — either no payment for this order, or it was
		// already collected/failed. Caller decides which.
		existing, gerr := r.GetByOrderID(ctx, orderID)
		if errors.Is(gerr, ErrNotFound) {
			return nil, ErrNotFound
		}
		if gerr != nil {
			return nil, gerr
		}
		return existing, ErrAlreadyExists
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

// MarkProcessed inserts (consumer, event_id). Returns true if newly recorded,
// false if it was already there (= duplicate event, skip handler).
func (r *PaymentsRepo) MarkProcessed(ctx context.Context, consumer, eventID string) (bool, error) {
	tag, err := r.Pool.Exec(ctx, `
		INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING
	`, consumer, eventID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
