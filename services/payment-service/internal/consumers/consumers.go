package consumers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/food-delivery/payment-service/internal/events"
	"github.com/food-delivery/payment-service/internal/repositories"
	"github.com/food-delivery/payment-service/internal/services"
)

const consumerName = "payment-service"

type orderTerminalData struct {
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

// Start subscribes to terminal-state order events for refund accounting.
// Charge initiation is now driven synchronously from the SPA via
// POST /payments — no order.placed consumer here anymore.
func Start(rabbit *events.Rabbit, repo *repositories.PaymentsRepo, svc *services.PaymentsService) error {
	return rabbit.Subscribe(
		[]string{"order.rejected", "order.cancelled"},
		func(ctx context.Context, env *events.Envelope) error {
			fresh, err := repo.MarkProcessed(ctx, consumerName, env.EventID)
			if err != nil {
				return fmt.Errorf("mark processed: %w", err)
			}
			if !fresh {
				slog.Debug("duplicate event, skipped", "event_id", env.EventID)
				return nil
			}

			var d orderTerminalData
			if err := json.Unmarshal(env.Data, &d); err != nil {
				return fmt.Errorf("decode %s: %w", env.EventType, err)
			}
			return svc.RecordRefund(ctx, d.OrderID, d.Reason)
		},
	)
}
