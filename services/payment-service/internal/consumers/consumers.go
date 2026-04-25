package consumers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/food-delivery/payment-service/internal/events"
	"github.com/food-delivery/payment-service/internal/money"
	"github.com/food-delivery/payment-service/internal/repositories"
	"github.com/food-delivery/payment-service/internal/services"
)

const consumerName = "payment-service"

type orderPlacedData struct {
	OrderID     string  `json:"order_id"`
	CustomerID  string  `json:"customer_id"`
	RestaurantID string `json:"restaurant_id"`
	Total       float64 `json:"total"`
}

type orderTerminalData struct {
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

func Start(rabbit *events.Rabbit, repo *repositories.PaymentsRepo, svc *services.PaymentsService) error {
	return rabbit.Subscribe(
		[]string{"order.placed", "order.rejected", "order.cancelled"},
		func(ctx context.Context, env *events.Envelope) error {
			fresh, err := repo.MarkProcessed(ctx, consumerName, env.EventID)
			if err != nil {
				return fmt.Errorf("mark processed: %w", err)
			}
			if !fresh {
				slog.Debug("duplicate event, skipped", "event_id", env.EventID)
				return nil
			}

			switch env.EventType {
			case "order.placed":
				var d orderPlacedData
				if err := json.Unmarshal(env.Data, &d); err != nil {
					return fmt.Errorf("decode order.placed: %w", err)
				}
				cust := d.CustomerID
				_, err := svc.CreateForOrder(ctx, services.CreateInput{
					OrderID:     d.OrderID,
					CustomerID:  &cust,
					AmountCents: money.FromFloat(d.Total),
				})
				return err

			case "order.rejected", "order.cancelled":
				var d orderTerminalData
				if err := json.Unmarshal(env.Data, &d); err != nil {
					return fmt.Errorf("decode %s: %w", env.EventType, err)
				}
				return svc.RecordRefund(ctx, d.OrderID, d.Reason)
			}
			return nil
		},
	)
}
